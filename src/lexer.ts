// V 언어 렉서
// V 설계 패턴 적용:
//   1. 전체 파일을 all_tokens[] 배열에 미리 스캔
//   2. 이후 파서는 all_tokens[tidx++] 만 호출
//   3. 줄/컬럼 추적

import { TK, Token, KEYWORDS } from './token.js'

// 문자 분류 헬퍼 (V는 이것도 256 룩업 테이블로 최적화)
function isDigit(c: string): boolean { return c >= '0' && c <= '9' }
function isAlpha(c: string): boolean {
  return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_'
}
function isAlNum(c: string): boolean { return isAlpha(c) || isDigit(c) }
function isHex(c: string): boolean {
  return isDigit(c) || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F')
}

export class Lexer {
  private src: string
  private pos: number  = 0
  private line: number = 1
  private col: number  = 0
  private startLine: number = 1
  private startCol: number  = 0

  // V 패턴: 전체 파일을 미리 스캔한 결과
  all_tokens: Token[] = []

  constructor(src: string) {
    this.src = src
  }

  // ──────────────────────────────────────────────────────
  //  공개 API
  // ──────────────────────────────────────────────────────

  /** 전체 소스를 한 번에 토큰화 */
  scanAll(): Token[] {
    while (true) {
      const tok = this.next()
      this.all_tokens.push(tok)
      if (tok.kind === TK.EOF) break
    }
    return this.all_tokens
  }

  // ──────────────────────────────────────────────────────
  //  내부: 다음 토큰 하나 생성
  // ──────────────────────────────────────────────────────

  private next(): Token {
    this.skipWhitespaceAndComments()

    // 파일 끝
    if (this.pos >= this.src.length) return this.make(TK.EOF, '')

    this.startLine = this.line
    this.startCol  = this.col
    const c  = this.peek()
    const c2 = this.peek2()  // 2글자 lookahead

    // ── 숫자 ────────────────────────────────────────────
    if (isDigit(c)) return this.scanNumber()

    // ── 식별자 / 키워드 ──────────────────────────────────
    if (isAlpha(c)) return this.scanIdent()

    // ── 문자 리터럴 `A` ──────────────────────────────────
    if (c === '`') return this.scanChar()

    // ── 문자열 ───────────────────────────────────────────
    if (c === "'") return this.scanString("'")
    if (c === '"') return this.scanString('"')

    // ── 2글자 연산자 우선 처리 ────────────────────────────
    const two = c + c2
    if (two === ':=') return this.eat2(TK.DECL,       ':=')
    if (two === '==') return this.eat2(TK.EQ,         '==')
    if (two === '!=') return this.eat2(TK.NE,         '!=')
    if (two === '<=') return this.eat2(TK.LE,         '<=')
    if (two === '>=') return this.eat2(TK.GE,         '>=')
    if (two === '<<') return this.eat2(TK.SHL,        '<<')
    if (two === '>>') return this.eat2(TK.SHR,        '>>')
    if (two === '&&') return this.eat2(TK.AND,        '&&')
    if (two === '||') return this.eat2(TK.OR,         '||')
    if (two === '++') return this.eat2(TK.INC,        '++')
    if (two === '--') return this.eat2(TK.DEC,        '--')
    if (two === '+=') return this.eat2(TK.PLUS_EQ,   '+=')
    if (two === '-=') return this.eat2(TK.MINUS_EQ,  '-=')
    if (two === '*=') return this.eat2(TK.STAR_EQ,   '*=')
    if (two === '/=') return this.eat2(TK.SLASH_EQ,  '/=')
    if (two === '%=') return this.eat2(TK.PERCENT_EQ,'%=')
    if (two === '<-') return this.eat2(TK.ARROW,     '<-')
    if (two === '..') return this.eat2(TK.DOTDOT,    '..')

    // ── 1글자 ────────────────────────────────────────────
    this.advance()
    switch (c) {
      case '+': return this.make(TK.PLUS,      '+')
      case '-': return this.make(TK.MINUS,     '-')
      case '*': return this.make(TK.STAR,      '*')
      case '/': return this.make(TK.SLASH,     '/')
      case '%': return this.make(TK.PERCENT,   '%')
      case '=': return this.make(TK.ASSIGN,    '=')
      case '<': return this.make(TK.LT,        '<')
      case '>': return this.make(TK.GT,        '>')
      case '!': return this.make(TK.BANG,      '!')
      case '&': return this.make(TK.AMP,       '&')
      case '|': return this.make(TK.PIPE,      '|')
      case '^': return this.make(TK.CARET,     '^')
      case '~': return this.make(TK.TILDE,     '~')
      case '(': return this.make(TK.LPAREN,    '(')
      case ')': return this.make(TK.RPAREN,    ')')
      case '{': return this.make(TK.LBRACE,    '{')
      case '}': return this.make(TK.RBRACE,    '}')
      case '[': return this.make(TK.LBRACKET,  '[')
      case ']': return this.make(TK.RBRACKET,  ']')
      case ',': return this.make(TK.COMMA,     ',')
      case ':': return this.make(TK.COLON,     ':')
      case ';': return this.make(TK.SEMICOLON, ';')
      case '.': return this.make(TK.DOT,       '.')
      case '?': return this.make(TK.QUESTION,  '?')
      case '@': return this.make(TK.AT,        '@')
      case '#': return this.make(TK.HASH,      '#')
      case '$': return this.make(TK.DOLLAR,    '$')
      default:
        return this.make(TK.ERROR, c)
    }
  }

  // ──────────────────────────────────────────────────────
  //  숫자 스캔
  // ──────────────────────────────────────────────────────

  private scanNumber(): Token {
    const start = this.pos

    // 0x 16진, 0b 2진, 0o 8진 지원
    if (this.peek() === '0') {
      const prefix = this.src[this.pos + 1]
      if (prefix === 'x' || prefix === 'X') {
        this.advance(); this.advance()  // 0x
        while (this.pos < this.src.length && (isHex(this.peek()) || this.peek() === '_'))
          this.advance()
        return this.make(TK.NUMBER, this.src.slice(start, this.pos))
      }
      if (prefix === 'b' || prefix === 'B') {
        this.advance(); this.advance()  // 0b
        while (this.pos < this.src.length && (this.peek() === '0' || this.peek() === '1' || this.peek() === '_'))
          this.advance()
        return this.make(TK.NUMBER, this.src.slice(start, this.pos))
      }
      if (prefix === 'o' || prefix === 'O') {
        this.advance(); this.advance()  // 0o
        while (this.pos < this.src.length && ((this.peek() >= '0' && this.peek() <= '7') || this.peek() === '_'))
          this.advance()
        return this.make(TK.NUMBER, this.src.slice(start, this.pos))
      }
    }

    // 10진수 (숫자 구분자 _ 지원: 1_000_000)
    while (this.pos < this.src.length && (isDigit(this.peek()) || this.peek() === '_'))
      this.advance()

    // 소수점
    if (this.peek() === '.' && isDigit(this.src[this.pos + 1] ?? '')) {
      this.advance()
      while (this.pos < this.src.length && isDigit(this.peek())) this.advance()
    }

    // 지수 (1e10, 1.5e-3)
    if (this.peek() === 'e' || this.peek() === 'E') {
      this.advance()
      if (this.peek() === '+' || this.peek() === '-') this.advance()
      while (this.pos < this.src.length && isDigit(this.peek())) this.advance()
    }

    return this.make(TK.NUMBER, this.src.slice(start, this.pos))
  }

  // ──────────────────────────────────────────────────────
  //  식별자 / 키워드 스캔
  // ──────────────────────────────────────────────────────

  private scanIdent(): Token {
    const start = this.pos
    while (this.pos < this.src.length && isAlNum(this.peek())) this.advance()
    const lit  = this.src.slice(start, this.pos)
    const kind = KEYWORDS[lit] ?? TK.NAME
    return this.make(kind, lit)
  }

  // ──────────────────────────────────────────────────────
  //  문자 리터럴 `A`
  // ──────────────────────────────────────────────────────

  private scanChar(): Token {
    this.advance()  // `
    let ch = ''
    if (this.peek() === '\\') {
      this.advance()
      ch = this.escapeChar(this.peek())
      this.advance()
    } else {
      ch = this.peek()
      this.advance()
    }
    if (this.peek() === '`') this.advance()
    return this.make(TK.CHAR, ch)
  }

  // ──────────────────────────────────────────────────────
  //  문자열 스캔 (V 스타일: 보간 $var, ${expr})
  // ──────────────────────────────────────────────────────

  private scanString(quote: string): Token {
    this.advance()  // 여는 따옴표 소비
    let result = ''

    while (this.pos < this.src.length) {
      const c = this.peek()
      if (c === quote) { this.advance(); break }

      if (c === '\\') {
        this.advance()
        result += this.escapeChar(this.peek())
        this.advance()
        continue
      }

      // $var 보간
      if (c === '$' && this.src[this.pos + 1] !== '{') {
        this.advance()  // $
        const start = this.pos
        while (this.pos < this.src.length && isAlNum(this.peek())) this.advance()
        result += '\x00INTERP:' + this.src.slice(start, this.pos) + '\x00'
        continue
      }

      // ${expr} 보간 (단순 처리: 중첩 브레이스까지)
      if (c === '$' && this.src[this.pos + 1] === '{') {
        this.advance(); this.advance()  // ${
        const start = this.pos
        let depth = 1
        while (this.pos < this.src.length && depth > 0) {
          if (this.peek() === '{') depth++
          if (this.peek() === '}') depth--
          if (depth > 0) this.advance()
        }
        result += '\x00INTERP:' + this.src.slice(start, this.pos) + '\x00'
        this.advance()  // }
        continue
      }

      if (c === '\n') this.line++
      result += c
      this.advance()
    }

    return this.make(TK.STRING, result)
  }

  // ──────────────────────────────────────────────────────
  //  공백 / 주석 스킵
  // ──────────────────────────────────────────────────────

  private skipWhitespaceAndComments(): void {
    while (this.pos < this.src.length) {
      const c = this.peek()

      // 공백/탭
      if (c === ' ' || c === '\t' || c === '\r') {
        this.advance(); continue
      }

      // 개행
      if (c === '\n') {
        this.line++; this.col = 0
        this.advance(); continue
      }

      // 줄 주석 //
      if (c === '/' && this.src[this.pos + 1] === '/') {
        while (this.pos < this.src.length && this.peek() !== '\n') this.advance()
        continue
      }

      // 블록 주석 /* */
      if (c === '/' && this.src[this.pos + 1] === '*') {
        this.advance(); this.advance()
        while (this.pos < this.src.length) {
          if (this.peek() === '\n') { this.line++; this.col = 0 }
          if (this.peek() === '*' && this.src[this.pos + 1] === '/') {
            this.advance(); this.advance(); break
          }
          this.advance()
        }
        continue
      }

      break
    }
  }

  // ──────────────────────────────────────────────────────
  //  유틸리티
  // ──────────────────────────────────────────────────────

  private peek():  string { return this.src[this.pos]     ?? '' }
  private peek2(): string { return this.src[this.pos + 1] ?? '' }

  private advance(): void {
    this.col++
    this.pos++
  }

  private eat2(kind: TK, lit: string): Token {
    this.advance(); this.advance()
    return this.make(kind, lit)
  }

  private make(kind: TK, lit: string): Token {
    return { kind, lit, line: this.startLine, col: this.startCol, pos: this.pos }
  }

  private escapeChar(c: string): string {
    switch (c) {
      case 'n':  return '\n'
      case 't':  return '\t'
      case 'r':  return '\r'
      case '\\': return '\\'
      case "'":  return "'"
      case '"':  return '"'
      case '0':  return '\0'
      default:   return c
    }
  }
}
