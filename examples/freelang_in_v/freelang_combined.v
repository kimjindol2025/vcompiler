// FreeLang-in-V: 자동 합성 파일
module main

// FreeLang 렉서 — V 언어로 구현
// FreeLang 토큰 종류

enum TK {
	eof
	name
	number
	string_lit
	// 연산자
	plus minus star slash percent
	eq ne lt gt le ge
	and_op or_op bang
	assign decl
	plus_eq minus_eq
	inc dec
	lparen rparen
	lbrace rbrace
	lbracket rbracket
	comma colon dot dotdot
	arrow
	// 키워드
	kw_fn kw_if kw_else kw_for kw_in
	kw_return kw_mut kw_pub
	kw_struct kw_import
	kw_true kw_false kw_null
	kw_break kw_continue
}

struct Token {
	kind TK
	lit  string
	line int
	col  int
}

struct Lexer {
mut:
	src   string
	pos   int
	line  int
	col   int
	start_line int
	start_col  int
}

fn new_lexer(src string) Lexer {
	return Lexer{
		src:  src
		pos:  0
		line: 1
		col:  0
		start_line: 1
		start_col:  0
	}
}

fn (mut l Lexer) peek_char() string {
	if l.pos >= l.src.len {
		return ''
	}
	return l.src[l.pos..l.pos + 1]
}

fn (mut l Lexer) peek2_char() string {
	if l.pos + 1 >= l.src.len {
		return ''
	}
	return l.src[l.pos + 1..l.pos + 2]
}

fn (mut l Lexer) advance() {
	l.col++
	l.pos++
}

fn (mut l Lexer) make_tok(kind TK, lit string) Token {
	return Token{ kind: kind, lit: lit, line: l.start_line, col: l.start_col }
}

fn is_digit(c string) bool {
	return c >= '0' && c <= '9'
}

fn is_alpha(c string) bool {
	return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c == '_'
}

fn is_alnum(c string) bool {
	return is_alpha(c) || is_digit(c)
}

fn keyword_kind(lit string) TK {
	return match lit {
		'fn'       { TK.kw_fn }
		'if'       { TK.kw_if }
		'else'     { TK.kw_else }
		'for'      { TK.kw_for }
		'in'       { TK.kw_in }
		'return'   { TK.kw_return }
		'mut'      { TK.kw_mut }
		'pub'      { TK.kw_pub }
		'struct'   { TK.kw_struct }
		'import'   { TK.kw_import }
		'true'     { TK.kw_true }
		'false'    { TK.kw_false }
		'null'     { TK.kw_null }
		'break'    { TK.kw_break }
		'continue' { TK.kw_continue }
		else       { TK.name }
	}
}

fn (mut l Lexer) skip_whitespace() {
	for l.pos < l.src.len {
		c := l.peek_char()
		if c == ' ' || c == '\t' || c == '\r' {
			l.advance()
			continue
		}
		if c == '\n' {
			l.line++
			l.col = 0
			l.advance()
			continue
		}
		// 줄 주석
		if c == '/' && l.peek2_char() == '/' {
			for l.pos < l.src.len && l.peek_char() != '\n' {
				l.advance()
			}
			continue
		}
		break
	}
}

fn (mut l Lexer) scan_number() Token {
	start := l.pos
	for l.pos < l.src.len && is_digit(l.peek_char()) {
		l.advance()
	}
	// 소수점
	if l.peek_char() == '.' && is_digit(l.peek2_char()) {
		l.advance()
		for l.pos < l.src.len && is_digit(l.peek_char()) {
			l.advance()
		}
	}
	return l.make_tok(TK.number, l.src[start..l.pos])
}

fn (mut l Lexer) scan_string() Token {
	l.advance() // 여는 따옴표
	mut result := ''
	for l.pos < l.src.len {
		c := l.peek_char()
		if c == '"' { l.advance(); break }
		if c == '\\' {
			l.advance()
			ec := l.peek_char()
			l.advance()
			result += match ec {
				'n'  { '\n' }
				't'  { '\t' }
				'\\' { '\\' }
				'"'  { '"' }
				else { ec }
			}
			continue
		}
		result += c
		l.advance()
	}
	return l.make_tok(TK.string_lit, result)
}

fn (mut l Lexer) scan_ident() Token {
	start := l.pos
	for l.pos < l.src.len && is_alnum(l.peek_char()) {
		l.advance()
	}
	lit := l.src[start..l.pos]
	kind := keyword_kind(lit)
	return l.make_tok(kind, lit)
}

fn (mut l Lexer) next() Token {
	l.skip_whitespace()
	if l.pos >= l.src.len {
		return l.make_tok(TK.eof, '')
	}

	l.start_line = l.line
	l.start_col  = l.col
	c  := l.peek_char()
	c2 := l.peek2_char()

	if is_digit(c) { return l.scan_number() }
	if is_alpha(c) { return l.scan_ident() }
	if c == '"'    { return l.scan_string() }

	// 2글자 연산자
	two := c + c2
	if two == ':=' { l.advance(); l.advance(); return l.make_tok(TK.decl,     ':=') }
	if two == '==' { l.advance(); l.advance(); return l.make_tok(TK.eq,       '==') }
	if two == '!=' { l.advance(); l.advance(); return l.make_tok(TK.ne,       '!=') }
	if two == '<=' { l.advance(); l.advance(); return l.make_tok(TK.le,       '<=') }
	if two == '>=' { l.advance(); l.advance(); return l.make_tok(TK.ge,       '>=') }
	if two == '&&' { l.advance(); l.advance(); return l.make_tok(TK.and_op,   '&&') }
	if two == '||' { l.advance(); l.advance(); return l.make_tok(TK.or_op,    '||') }
	if two == '++' { l.advance(); l.advance(); return l.make_tok(TK.inc,      '++') }
	if two == '--' { l.advance(); l.advance(); return l.make_tok(TK.dec,      '--') }
	if two == '+=' { l.advance(); l.advance(); return l.make_tok(TK.plus_eq,  '+=') }
	if two == '-=' { l.advance(); l.advance(); return l.make_tok(TK.minus_eq, '-=') }
	if two == '->' { l.advance(); l.advance(); return l.make_tok(TK.arrow,    '->') }
	if two == '..' { l.advance(); l.advance(); return l.make_tok(TK.dotdot,   '..') }

	// 1글자
	l.advance()
	return match c {
		'+' { l.make_tok(TK.plus,     '+') }
		'-' { l.make_tok(TK.minus,    '-') }
		'*' { l.make_tok(TK.star,     '*') }
		'/' { l.make_tok(TK.slash,    '/') }
		'%' { l.make_tok(TK.percent,  '%') }
		'=' { l.make_tok(TK.assign,   '=') }
		'<' { l.make_tok(TK.lt,       '<') }
		'>' { l.make_tok(TK.gt,       '>') }
		'!' { l.make_tok(TK.bang,     '!') }
		'(' { l.make_tok(TK.lparen,   '(') }
		')' { l.make_tok(TK.rparen,   ')') }
		'{' { l.make_tok(TK.lbrace,   '{') }
		'}' { l.make_tok(TK.rbrace,   '}') }
		'[' { l.make_tok(TK.lbracket, '[') }
		']' { l.make_tok(TK.rbracket, ']') }
		',' { l.make_tok(TK.comma,    ',') }
		':' { l.make_tok(TK.colon,    ':') }
		'.' { l.make_tok(TK.dot,      '.') }
		else { l.make_tok(TK.eof,     c) }
	}
}

fn (mut l Lexer) scan_all() []Token {
	mut tokens := []Token{}
	for {
		tok := l.next()
		tokens << tok
		if tok.kind == TK.eof { break }
	}
	return tokens
}

// FreeLang AST 노드 — V 언어로 구현

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

// FreeLang 파서 — V 언어로 구현
// Recursive Descent + Pratt 우선순위

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

// FreeLang VM — V 언어로 구현 (트리 워킹 인터프리터)

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

// FreeLang 인터프리터 메인 진입점 — V 언어로 구현
// 실행: npx tsx ../../src/main.ts main.v <script.fl>
//       (우리가 만든 V 컴파일러로 이 V 코드를 실행)

fn main() {
	args := ['freelang']  // 실제로는 os.args 사용

	// 내장 테스트 프로그램 실행
	src := '
fn add(a int, b int) int {
  return a + b
}

fn fibonacci(n int) int {
  if n <= 1 {
    return n
  }
  return fibonacci(n - 1) + fibonacci(n - 2)
}

fn main() {
  println("=== FreeLang in V ===")
  result := add(10, 32)
  println(result)

  println("피보나치 수열:")
  mut i := 0
  for i <= 10 {
    println(fibonacci(i))
    i = i + 1
  }

  nums := [1, 2, 3, 4, 5]
  println("배열 합계:")
  mut total := 0
  for x in nums {
    total = total + x
  }
  println(total)
}
'

	mut lexer  := new_lexer(src)
	tokens     := lexer.scan_all()
	mut parser := new_parser(tokens)
	stmts      := parser.parse_file()
	mut vm     := new_vm()
	vm.run(stmts)

	println("\n=== 인터프리터 완료 ===")
	println("V 언어로 작성된 FreeLang 인터프리터")
	println("파싱된 문장 수: ${stmts.len}")
	println("등록된 함수 수: ${vm.fns.len}")
}
