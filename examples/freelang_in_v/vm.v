// FreeLang VM — V 언어로 구현 (트리 워킹 인터프리터)
module main

// ── 시그널 (return/break/continue 처리) ─────────────────
struct ReturnSignal {
	val Val
}

struct BreakSignal {}
struct ContinueSignal {}

// ── 스코프 ───────────────────────────────────────────────
struct VarEntry {
mut:
	val    Val
	is_mut bool
}

struct Scope {
mut:
	vars   map[string]VarEntry
	parent &Scope
}

fn new_scope(parent &Scope) &Scope {
	return &Scope{ vars: map[string]VarEntry{}, parent: parent }
}

fn (mut s Scope) declare(name string, val Val, is_mut bool) {
	s.vars[name] = VarEntry{ val: val, is_mut: is_mut }
}

fn (mut s Scope) set(name string, val Val) {
	if name in s.vars {
		if !s.vars[name].is_mut {
			println('런타임 에러: "${name}" 은 불변 변수입니다')
			return
		}
		s.vars[name] = VarEntry{ val: val, is_mut: true }
		return
	}
	if s.parent != unsafe { nil } {
		s.parent.set(name, val)
		return
	}
	println('런타임 에러: "${name}" 은 선언되지 않았습니다')
}

fn (s Scope) get(name string) ?Val {
	if name in s.vars {
		return s.vars[name].val
	}
	if s.parent != unsafe { nil } {
		return s.parent.get(name)
	}
	return none
}

// ── VM ──────────────────────────────────────────────────
struct VM {
mut:
	global    &Scope
	fns       map[string]FnDecl
}

fn new_vm() &VM {
	mut vm := &VM{ global: new_scope(unsafe { nil }), fns: map[string]FnDecl{} }
	vm.register_builtins()
	return vm
}

fn (mut vm VM) register_builtins() {
	// println 등록 (특수 처리)
	vm.global.declare('println', val_string('__builtin_println'), false)
	vm.global.declare('print',   val_string('__builtin_print'),   false)
	vm.global.declare('len',     val_string('__builtin_len'),     false)
	vm.global.declare('str',     val_string('__builtin_str'),     false)
	vm.global.declare('int',     val_string('__builtin_int'),     false)
}

fn (mut vm VM) run(stmts []Stmt) {
	// 1패스: 함수 등록
	for s in stmts {
		if s.kind == StmtKind.s_fn_decl {
			vm.fns[s.fn_decl.name] = *s.fn_decl
			vm.global.declare(s.fn_decl.name, val_string('__fn_${s.fn_decl.name}'), false)
		}
	}

	// 2패스: main 실행
	if 'main' in vm.fns {
		vm.call_fn('main', []Val{})
		return
	}

	// main이 없으면 최상위 문장 실행
	for s in stmts {
		if s.kind != StmtKind.s_fn_decl {
			vm.exec_stmt(s, mut vm.global)
		}
	}
}

fn (mut vm VM) call_fn(name string, args []Val) Val {
	if !(name in vm.fns) {
		println('런타임 에러: 함수 "${name}" 없음')
		return val_null()
	}
	decl := vm.fns[name]
	mut scope := new_scope(vm.global)
	for i, param in decl.params {
		scope.declare(param.name, if i < args.len { args[i] } else { val_null() }, param.is_mut)
	}
	result := vm.exec_block(decl.body, mut scope)
	return result
}

fn (mut vm VM) exec_block(block Block, mut scope Scope) Val {
	for s in block.stmts {
		result := vm.exec_stmt(s, mut scope)
		if result.kind != ValKind.v_void {
			return result
		}
	}
	return val_void()
}

fn (mut vm VM) exec_stmt(stmt Stmt, mut scope Scope) Val {
	match stmt.kind {
		.s_expr {
			vm.eval_expr(*stmt.expr, mut scope)
			return val_void()
		}
		.s_assign {
			val := vm.eval_expr(*stmt.value, mut scope)
			if stmt.op == ':=' {
				scope.declare(stmt.target.s_val, val, stmt.is_mut)
			} else if stmt.op == '=' {
				scope.set(stmt.target.s_val, val)
			} else if stmt.op == '+=' {
				cur := scope.get(stmt.target.s_val) or { val_int(0) }
				scope.set(stmt.target.s_val, vm.apply_binop('+', cur, val))
			} else if stmt.op == '-=' {
				cur := scope.get(stmt.target.s_val) or { val_int(0) }
				scope.set(stmt.target.s_val, vm.apply_binop('-', cur, val))
			}
			return val_void()
		}
		.s_return {
			if stmt.ret_val.kind == ExprKind.e_null_lit && stmt.ret_val.s_val == '' {
				return val_void()
			}
			return vm.eval_expr(*stmt.ret_val, mut scope)
		}
		.s_if {
			for b in stmt.branches {
				// else 브랜치: cond가 기본값
				if b.cond.kind == ExprKind.e_null_lit && b.cond.s_val == '' {
					return vm.exec_block(b.body, mut scope)
				}
				cond_val := vm.eval_expr(*b.cond, mut scope)
				if val_truthy(cond_val) {
					return vm.exec_block(b.body, mut scope)
				}
			}
			return val_void()
		}
		.s_for_c {
			for {
				// cond 체크
				if stmt.cond.kind != ExprKind.e_null_lit || stmt.cond.s_val != '' {
					cond_val := vm.eval_expr(*stmt.cond, mut scope)
					if !val_truthy(cond_val) { break }
				}
				result := vm.exec_block(stmt.body, mut scope)
				if result.kind != ValKind.v_void {
					return result
				}
			}
			return val_void()
		}
		.s_for_in {
			iter := vm.eval_expr(*stmt.iterable, mut scope)
			if iter.kind == ValKind.v_array {
				for i, elem in iter.elems {
					mut inner := new_scope(mut scope)
					if stmt.key_var != '' {
						inner.declare(stmt.key_var, val_int(i), false)
					}
					inner.declare(stmt.val_var, elem, false)
					result := vm.exec_block(stmt.body, mut inner)
					if result.kind != ValKind.v_void {
						return result
					}
				}
			}
			return val_void()
		}
		.s_fn_decl {
			// 중첩 함수 등록
			vm.fns[stmt.fn_decl.name] = *stmt.fn_decl
			return val_void()
		}
		else {
			return val_void()
		}
	}
}

fn (mut vm VM) eval_expr(expr Expr, mut scope Scope) Val {
	match expr.kind {
		.e_int_lit    { return val_int(expr.i_val) }
		.e_float_lit  { return val_float(expr.f_val) }
		.e_string_lit { return val_string(expr.s_val) }
		.e_bool_lit   { return val_bool(expr.b_val) }
		.e_null_lit   { return val_null() }

		.e_ident {
			name := expr.s_val
			val := scope.get(name) or {
				println('런타임 에러: "${name}" 미선언')
				return val_null()
			}
			return val
		}

		.e_prefix {
			e := vm.eval_expr(*expr.expr, mut scope)
			if expr.op == '-' {
				if e.kind == ValKind.v_int   { return val_int(-e.i_val) }
				if e.kind == ValKind.v_float { return val_float(-e.f_val) }
			}
			if expr.op == '!' {
				return val_bool(!val_truthy(e))
			}
			return e
		}

		.e_infix {
			// 후위 증감
			if expr.op == '++post' {
				cur := vm.eval_expr(*expr.left, mut scope)
				next := if cur.kind == ValKind.v_int { val_int(cur.i_val + 1) } else { cur }
				scope.set(expr.left.s_val, next)
				return cur
			}
			if expr.op == '--post' {
				cur := vm.eval_expr(*expr.left, mut scope)
				next := if cur.kind == ValKind.v_int { val_int(cur.i_val - 1) } else { cur }
				scope.set(expr.left.s_val, next)
				return cur
			}
			// 단락 평가
			if expr.op == '&&' {
				l := vm.eval_expr(*expr.left, mut scope)
				if !val_truthy(l) { return val_bool(false) }
				r := vm.eval_expr(*expr.right, mut scope)
				return val_bool(val_truthy(r))
			}
			if expr.op == '||' {
				l := vm.eval_expr(*expr.left, mut scope)
				if val_truthy(l) { return val_bool(true) }
				r := vm.eval_expr(*expr.right, mut scope)
				return val_bool(val_truthy(r))
			}
			l := vm.eval_expr(*expr.left, mut scope)
			r := vm.eval_expr(*expr.right, mut scope)
			return vm.apply_binop(expr.op, l, r)
		}

		.e_call {
			// 이름 가져오기
			callee := vm.eval_expr(*expr.callee, mut scope)
			args := expr.args.map(vm.eval_expr(it, mut scope))

			// 내장 함수
			if callee.kind == ValKind.v_string && callee.s_val.starts_with('__builtin_') {
				return vm.call_builtin(callee.s_val, args)
			}
			if callee.kind == ValKind.v_string && callee.s_val.starts_with('__fn_') {
				fn_name := callee.s_val[5..]
				return vm.call_fn(fn_name, args)
			}
			return val_null()
		}

		.e_index {
			obj := vm.eval_expr(*expr.obj, mut scope)
			idx := vm.eval_expr(*expr.index, mut scope)
			if obj.kind == ValKind.v_array && idx.kind == ValKind.v_int {
				i := idx.i_val
				if i >= 0 && i < obj.elems.len {
					return obj.elems[i]
				}
				println('런타임 에러: 인덱스 ${i} 범위 초과')
				return val_null()
			}
			return val_null()
		}

		.e_selector {
			// obj.field — 현재 미지원 (확장 가능)
			return val_null()
		}

		.e_array {
			elems := expr.elems.map(vm.eval_expr(it, mut scope))
			return Val{ kind: ValKind.v_array, elems: elems }
		}

		else { return val_null() }
	}
}

fn (mut vm VM) apply_binop(op string, l Val, r Val) Val {
	// 문자열
	if l.kind == ValKind.v_string && op == '+' {
		return val_string(l.s_val + val_to_string(r))
	}
	if l.kind == ValKind.v_string && r.kind == ValKind.v_string {
		return match op {
			'==' { val_bool(l.s_val == r.s_val) }
			'!=' { val_bool(l.s_val != r.s_val) }
			else { val_null() }
		}
	}

	// 정수 연산
	if l.kind == ValKind.v_int && r.kind == ValKind.v_int {
		li := l.i_val
		ri := r.i_val
		return match op {
			'+'  { val_int(li + ri) }
			'-'  { val_int(li - ri) }
			'*'  { val_int(li * ri) }
			'/'  { if ri == 0 { val_int(0) } else { val_int(li / ri) } }
			'%'  { val_int(li % ri) }
			'==' { val_bool(li == ri) }
			'!=' { val_bool(li != ri) }
			'<'  { val_bool(li < ri) }
			'>'  { val_bool(li > ri) }
			'<=' { val_bool(li <= ri) }
			'>=' { val_bool(li >= ri) }
			else { val_null() }
		}
	}

	// float 연산
	lf := if l.kind == ValKind.v_float { l.f_val } else if l.kind == ValKind.v_int { f64(l.i_val) } else { 0.0 }
	rf := if r.kind == ValKind.v_float { r.f_val } else if r.kind == ValKind.v_int { f64(r.i_val) } else { 0.0 }
	if l.kind == ValKind.v_float || r.kind == ValKind.v_float {
		return match op {
			'+'  { val_float(lf + rf) }
			'-'  { val_float(lf - rf) }
			'*'  { val_float(lf * rf) }
			'/'  { val_float(lf / rf) }
			'==' { val_bool(lf == rf) }
			'!=' { val_bool(lf != rf) }
			'<'  { val_bool(lf < rf) }
			'>'  { val_bool(lf > rf) }
			'<=' { val_bool(lf <= rf) }
			'>=' { val_bool(lf >= rf) }
			else { val_null() }
		}
	}

	return val_null()
}

fn (mut vm VM) call_builtin(name string, args []Val) Val {
	match name {
		'__builtin_println' {
			if args.len == 0 {
				println('')
			} else {
				mut parts := []string{}
				for a in args { parts << val_to_string(a) }
				println(parts.join(' '))
			}
			return val_void()
		}
		'__builtin_print' {
			if args.len > 0 {
				print(val_to_string(args[0]))
			}
			return val_void()
		}
		'__builtin_len' {
			if args.len > 0 {
				a := args[0]
				if a.kind == ValKind.v_array  { return val_int(a.elems.len) }
				if a.kind == ValKind.v_string { return val_int(a.s_val.len) }
			}
			return val_int(0)
		}
		'__builtin_str' {
			if args.len > 0 { return val_string(val_to_string(args[0])) }
			return val_string('')
		}
		'__builtin_int' {
			if args.len > 0 {
				a := args[0]
				if a.kind == ValKind.v_int   { return a }
				if a.kind == ValKind.v_float { return val_int(int(a.f_val)) }
				if a.kind == ValKind.v_string { return val_int(a.s_val.int()) }
			}
			return val_int(0)
		}
		else { return val_null() }
	}
}
