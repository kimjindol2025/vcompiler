// FreeLang 파서 — V 언어로 구현
// Recursive Descent + Pratt 우선순위
module main

struct Parser {
mut:
	tokens []Token
	tidx   int
	tok    Token
	peek   Token
}

fn new_parser(tokens []Token) Parser {
	mut p := Parser{ tokens: tokens, tidx: 0 }
	p.tok  = tokens[0]
	p.peek = if tokens.len > 1 { tokens[1] } else { tokens[0] }
	return p
}

fn (mut p Parser) next() {
	p.tidx++
	p.tok  = p.tokens[p.tidx] or { Token{ kind: TK.eof, lit: '' } }
	p.peek = p.tokens[p.tidx + 1] or { Token{ kind: TK.eof, lit: '' } }
}

fn (mut p Parser) expect(kind TK) Token {
	t := p.tok
	if t.kind != kind {
		println('파서 에러: ${t.line}:${t.col} — "${kind}" 예상, "${t.lit}" 발견')
	}
	p.next()
	return t
}

fn (mut p Parser) expect_name() string {
	lit := p.tok.lit
	p.next()
	return lit
}

// ── 우선순위 테이블 ────────────────────────────────────

fn prec(kind TK) int {
	return match kind {
		.or_op   { 1 }
		.and_op  { 2 }
		.eq, .ne { 4 }
		.lt, .gt, .le, .ge { 5 }
		.plus, .minus { 7 }
		.star, .slash, .percent { 8 }
		else { 0 }
	}
}

// ── 표현식 파싱 ──────────────────────────────────────

fn (mut p Parser) parse_expr(min_prec int) &Expr {
	mut left := p.parse_primary()

	for {
		// 후위: ++, --
		if p.tok.kind == TK.inc {
			p.next()
			left = &Expr{ kind: ExprKind.e_infix, op: '++post', left: left, right: &Expr{} }
			continue
		}
		if p.tok.kind == TK.dec {
			p.next()
			left = &Expr{ kind: ExprKind.e_infix, op: '--post', left: left, right: &Expr{} }
			continue
		}
		// 배열 인덱싱
		if p.tok.kind == TK.lbracket {
			p.next()
			idx := p.parse_expr(0)
			p.expect(TK.rbracket)
			left = &Expr{ kind: ExprKind.e_index, obj: left, index: idx }
			continue
		}
		// 필드 접근
		if p.tok.kind == TK.dot {
			p.next()
			field := p.expect_name()
			left = &Expr{ kind: ExprKind.e_selector, obj: left, field: field }
			continue
		}
		// 함수 호출
		if p.tok.kind == TK.lparen {
			p.next()
			mut args := []Expr{}
			for p.tok.kind != TK.rparen && p.tok.kind != TK.eof {
				args << *p.parse_expr(0)
				if p.tok.kind == TK.comma { p.next() }
			}
			p.expect(TK.rparen)
			left = &Expr{ kind: ExprKind.e_call, callee: left, args: args }
			continue
		}
		// 이항 연산
		p_val := prec(p.tok.kind)
		if p_val <= min_prec { break }
		op := p.tok.lit
		p.next()
		right := p.parse_expr(p_val)
		left = &Expr{ kind: ExprKind.e_infix, op: op, left: left, right: right }
	}

	return left
}

fn (mut p Parser) parse_primary() &Expr {
	pos_tok := p.tok

	// 숫자
	if pos_tok.kind == TK.number {
		p.next()
		// 정수 vs 실수
		if pos_tok.lit.contains('.') {
			return &Expr{ kind: ExprKind.e_float_lit, f_val: pos_tok.lit.f64() }
		}
		return &Expr{ kind: ExprKind.e_int_lit, i_val: pos_tok.lit.int() }
	}

	// 문자열
	if pos_tok.kind == TK.string_lit {
		p.next()
		return &Expr{ kind: ExprKind.e_string_lit, s_val: pos_tok.lit }
	}

	// bool
	if pos_tok.kind == TK.kw_true  { p.next(); return &Expr{ kind: ExprKind.e_bool_lit, b_val: true } }
	if pos_tok.kind == TK.kw_false { p.next(); return &Expr{ kind: ExprKind.e_bool_lit, b_val: false } }
	if pos_tok.kind == TK.kw_null  { p.next(); return &Expr{ kind: ExprKind.e_null_lit } }

	// 단항 -/!
	if pos_tok.kind == TK.minus || pos_tok.kind == TK.bang {
		p.next()
		e := p.parse_expr(9)
		return &Expr{ kind: ExprKind.e_prefix, op: pos_tok.lit, expr: e }
	}

	// 괄호
	if pos_tok.kind == TK.lparen {
		p.next()
		e := p.parse_expr(0)
		p.expect(TK.rparen)
		return e
	}

	// 배열 리터럴
	if pos_tok.kind == TK.lbracket {
		p.next()
		mut elems := []Expr{}
		for p.tok.kind != TK.rbracket && p.tok.kind != TK.eof {
			elems << *p.parse_expr(0)
			if p.tok.kind == TK.comma { p.next() }
		}
		p.expect(TK.rbracket)
		return &Expr{ kind: ExprKind.e_array, elems: elems }
	}

	// 식별자
	if pos_tok.kind == TK.name {
		p.next()
		return &Expr{ kind: ExprKind.e_ident, s_val: pos_tok.lit }
	}

	// 에러 복구
	p.next()
	return &Expr{ kind: ExprKind.e_null_lit }
}

// ── 문장 파싱 ──────────────────────────────────────────

fn (mut p Parser) parse_stmt() Stmt {
	t := p.tok

	// fn 선언
	if t.kind == TK.kw_fn || (t.kind == TK.kw_pub && p.peek.kind == TK.kw_fn) {
		is_pub := t.kind == TK.kw_pub
		if is_pub { p.next() }
		return p.parse_fn_decl(is_pub)
	}

	// return
	if t.kind == TK.kw_return {
		p.next()
		if p.tok.kind == TK.rbrace || p.tok.kind == TK.eof {
			return Stmt{ kind: StmtKind.s_return, ret_val: &Expr{} }
		}
		e := p.parse_expr(0)
		return Stmt{ kind: StmtKind.s_return, ret_val: e }
	}

	// break / continue
	if t.kind == TK.kw_break    { p.next(); return Stmt{ kind: StmtKind.s_break } }
	if t.kind == TK.kw_continue { p.next(); return Stmt{ kind: StmtKind.s_continue } }

	// if
	if t.kind == TK.kw_if { return p.parse_if() }

	// for
	if t.kind == TK.kw_for { return p.parse_for() }

	// 변수 선언/대입
	return p.parse_expr_or_assign()
}

fn (mut p Parser) parse_block() Block {
	p.expect(TK.lbrace)
	mut stmts := []Stmt{}
	for p.tok.kind != TK.rbrace && p.tok.kind != TK.eof {
		stmts << p.parse_stmt()
	}
	p.expect(TK.rbrace)
	return Block{ stmts: stmts }
}

fn (mut p Parser) parse_fn_decl(is_pub bool) Stmt {
	p.expect(TK.kw_fn)
	name := p.expect_name()
	p.expect(TK.lparen)

	mut params := []Param{}
	for p.tok.kind != TK.rparen && p.tok.kind != TK.eof {
		is_mut := p.tok.kind == TK.kw_mut
		if is_mut { p.next() }
		pname := p.expect_name()
		ptype := if p.tok.kind == TK.name { t := p.tok.lit; p.next(); t } else { 'any' }
		params << Param{ name: pname, type_s: ptype, is_mut: is_mut }
		if p.tok.kind == TK.comma { p.next() }
	}
	p.expect(TK.rparen)

	// 반환 타입 (선택)
	mut ret := 'void'
	if p.tok.kind == TK.name {
		ret = p.tok.lit; p.next()
	}

	body := p.parse_block()
	decl := &FnDecl{ name: name, params: params, ret: ret, body: body, is_pub: is_pub }
	return Stmt{ kind: StmtKind.s_fn_decl, fn_decl: decl }
}

fn (mut p Parser) parse_if() Stmt {
	p.expect(TK.kw_if)
	cond := p.parse_expr(0)
	body := p.parse_block()
	mut branches := [IfBranch{ cond: cond, body: body }]

	for p.tok.kind == TK.kw_else {
		p.next()
		if p.tok.kind == TK.kw_if {
			p.next()
			ec := p.parse_expr(0)
			eb := p.parse_block()
			branches << IfBranch{ cond: ec, body: eb }
		} else {
			eb := p.parse_block()
			branches << IfBranch{ cond: &Expr{}, body: eb }  // else
			break
		}
	}
	return Stmt{ kind: StmtKind.s_if, branches: branches }
}

fn (mut p Parser) parse_for() Stmt {
	p.expect(TK.kw_for)

	// for x in arr
	if p.tok.kind == TK.name && p.peek.kind == TK.kw_in {
		val_var := p.tok.lit; p.next()
		p.next()  // in
		iter := p.parse_expr(0)
		body := p.parse_block()
		return Stmt{ kind: StmtKind.s_for_in, val_var: val_var, iterable: iter, body: body }
	}

	// for i, x in arr
	if p.tok.kind == TK.name {
		// for { ... } (while true)
		// for cond { ... }
		cond := p.parse_expr(0)
		body := p.parse_block()
		return Stmt{ kind: StmtKind.s_for_c, cond: cond, body: body,
			init: &Stmt{}, post: &Stmt{} }
	}

	// for {} (무한루프)
	body := p.parse_block()
	return Stmt{ kind: StmtKind.s_for_c, cond: &Expr{}, body: body,
		init: &Stmt{}, post: &Stmt{} }
}

fn (mut p Parser) parse_expr_or_assign() Stmt {
	mut is_mut := false
	if p.tok.kind == TK.kw_mut {
		is_mut = true
		p.next()
	}

	left := p.parse_expr(0)

	// 대입/선언
	op := p.tok.lit
	if p.tok.kind == TK.decl || p.tok.kind == TK.assign ||
	   p.tok.kind == TK.plus_eq || p.tok.kind == TK.minus_eq {
		p.next()
		right := p.parse_expr(0)
		return Stmt{ kind: StmtKind.s_assign, target: left, op: op, value: right, is_mut: is_mut }
	}

	return Stmt{ kind: StmtKind.s_expr, expr: left }
}

fn (mut p Parser) parse_file() []Stmt {
	mut stmts := []Stmt{}
	for p.tok.kind != TK.eof {
		stmts << p.parse_stmt()
	}
	return stmts
}
