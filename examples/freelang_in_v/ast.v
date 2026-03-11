// FreeLang AST 노드 — V 언어로 구현
module main

// ── 값 타입 (런타임) ─────────────────────────────────────
enum ValKind {
	v_int
	v_float
	v_string
	v_bool
	v_null
	v_array
	v_fn
	v_void
}

struct Val {
mut:
	kind    ValKind
	i_val   int        // int
	f_val   f64        // float
	s_val   string     // string / fn 이름
	b_val   bool       // bool
	elems   []Val      // array
	fn_decl &FnDecl    // fn
}

fn val_int(n int) Val {
	return Val{ kind: ValKind.v_int, i_val: n }
}

fn val_float(f f64) Val {
	return Val{ kind: ValKind.v_float, f_val: f }
}

fn val_string(s string) Val {
	return Val{ kind: ValKind.v_string, s_val: s }
}

fn val_bool(b bool) Val {
	return Val{ kind: ValKind.v_bool, b_val: b }
}

fn val_null() Val {
	return Val{ kind: ValKind.v_null }
}

fn val_void() Val {
	return Val{ kind: ValKind.v_void }
}

fn val_to_string(v Val) string {
	return match v.kind {
		.v_int    { '${v.i_val}' }
		.v_float  { '${v.f_val}' }
		.v_string { v.s_val }
		.v_bool   { if v.b_val { 'true' } else { 'false' } }
		.v_null   { 'null' }
		.v_void   { '' }
		.v_fn     { 'fn(${v.s_val})' }
		.v_array  {
			mut parts := []string{}
			for e in v.elems {
				parts << val_to_string(e)
			}
			'[' + parts.join(', ') + ']'
		}
	}
}

fn val_truthy(v Val) bool {
	return match v.kind {
		.v_bool   { v.b_val }
		.v_int    { v.i_val != 0 }
		.v_float  { v.f_val != 0.0 }
		.v_string { v.s_val != '' }
		.v_null   { false }
		.v_void   { false }
		else      { true }
	}
}

// ── AST 표현식 ──────────────────────────────────────────
enum ExprKind {
	e_int_lit
	e_float_lit
	e_string_lit
	e_bool_lit
	e_null_lit
	e_ident
	e_infix
	e_prefix
	e_call
	e_index
	e_selector
	e_array
	e_assign_expr
}

struct Expr {
mut:
	kind    ExprKind
	// 리터럴
	i_val   int
	f_val   f64
	s_val   string
	b_val   bool
	// 이항
	op      string
	left    &Expr
	right   &Expr
	// 단항
	expr    &Expr
	// 호출
	callee  &Expr
	args    []Expr
	// 인덱싱 / 필드
	obj     &Expr
	field   string
	index   &Expr
	// 배열
	elems   []Expr
}

// ── AST 문장 ────────────────────────────────────────────
enum StmtKind {
	s_expr
	s_assign
	s_fn_decl
	s_return
	s_if
	s_for_c
	s_for_in
	s_block
	s_break
	s_continue
}

struct Param {
	name   string
	type_s string
	is_mut bool
}

struct FnDecl {
	name    string
	params  []Param
	ret     string
	body    Block
	is_pub  bool
}

struct Block {
mut:
	stmts []Stmt
}

struct IfBranch {
	cond &Expr  // null이면 else
	body Block
}

struct Stmt {
mut:
	kind      StmtKind
	// expr 문
	expr      &Expr
	// assign
	target    &Expr
	op        string
	value     &Expr
	is_mut    bool
	// fn
	fn_decl   &FnDecl
	// return
	ret_val   &Expr  // null이면 void return
	// if
	branches  []IfBranch
	// for_c
	init      &Stmt
	cond      &Expr
	post      &Stmt
	body      Block
	// for_in
	key_var   string
	val_var   string
	iterable  &Expr
}
