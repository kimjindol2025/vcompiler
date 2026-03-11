// FreeLang 렉서 — V 언어로 구현
// FreeLang 토큰 종류
module main

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
