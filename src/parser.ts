// V 언어 파서
// V 설계 패턴:
//   - tok(현재) + peek(다음) 2-lookahead
//   - Recursive Descent
//   - Pratt 우선순위 클라이밍으로 표현식 처리
//   - 에러 수집 후 일괄 보고

import { TK, Token, PRECEDENCE } from './token.js'
import * as A from './ast.js'
import { Lexer } from './lexer.js'

export interface ParseError {
  msg:  string
  line: number
  col:  number
}

export class Parser {
  private tokens: Token[]  // 사전 스캔된 all_tokens
  private tidx = 0         // 현재 토큰 인덱스

  // V 패턴: tok + peek 2-lookahead
  private tok:  Token
  private peek: Token

  errors: ParseError[] = []

  // 컨텍스트 추적 플래그 (V Parser 동일 패턴)
  private insideFn    = false
  private insideFor   = false
  private insideMatch = false

  constructor(tokens: Token[]) {
    this.tokens = tokens
    // 처음 두 토큰으로 tok, peek 초기화
    this.tok  = tokens[0]  ?? this.eofToken()
    this.peek = tokens[1]  ?? this.eofToken()
    this.tidx = 2
  }

  // ──────────────────────────────────────────────────────
  //  공개 API
  // ──────────────────────────────────────────────────────

  parseFile(): A.VFile {
    let moduleName = 'main'

    // module 선언이 있으면 파싱
    if (this.tok.kind === TK.KW_MODULE) {
      this.next()
      moduleName = this.expectName()
    }

    const stmts: A.Stmt[] = []
    while (this.tok.kind !== TK.EOF) {
      const s = this.parseTopStmt()
      if (s) stmts.push(s)
    }

    return { module: moduleName, stmts }
  }

  // ──────────────────────────────────────────────────────
  //  최상위 문장
  // ──────────────────────────────────────────────────────

  private parseTopStmt(): A.Stmt | null {
    // 빈 세미콜론 무시
    while (this.tok.kind === TK.SEMICOLON) this.next()
    if (this.tok.kind === TK.EOF) return null

    const pos = this.pos()

    // pub 수식어
    let isPub = false
    if (this.tok.kind === TK.KW_PUB) { this.next(); isPub = true }

    switch (this.tok.kind) {
      case TK.KW_FN:        return this.parseFnDecl(isPub)
      case TK.KW_STRUCT:    return this.parseStructDecl(isPub)
      case TK.KW_INTERFACE: return this.parseInterfaceDecl(isPub)
      case TK.KW_ENUM:      return this.parseEnumDecl(isPub)
      case TK.KW_TYPE:      return this.parseTypeDecl(isPub)
      case TK.KW_CONST:     return this.parseConstDecl(isPub)
      case TK.KW_IMPORT:    return this.parseImport()
      default:
        if (isPub) this.error(`'pub' 뒤에 선언이 와야 합니다`, pos)
        return this.parseStmt()
    }
  }

  // ──────────────────────────────────────────────────────
  //  일반 문장
  // ──────────────────────────────────────────────────────

  private parseStmt(): A.Stmt {
    while (this.tok.kind === TK.SEMICOLON) this.next()
    const pos = this.pos()

    switch (this.tok.kind) {
      case TK.KW_RETURN:   return this.parseReturn()
      case TK.KW_FOR:      return this.parseFor()
      case TK.KW_BREAK:    return this.parseBranch('break')
      case TK.KW_CONTINUE: return this.parseBranch('continue')
      case TK.KW_DEFER:    return this.parseDefer()
      case TK.KW_ASSERT:   return this.parseAssert()
      case TK.KW_GOTO: {
        this.next()
        const label = this.expectName()
        return { t: 'goto', label, pos } as A.GotoStmt
      }
      case TK.LBRACE:      return this.parseBlock()
      default:
        return this.parseExprOrAssignStmt()
    }
  }

  // ──────────────────────────────────────────────────────
  //  표현식 문장 vs 대입문 구분
  //  x := 1 / x = 2 / x += 3 / x++ (postfix)
  // ──────────────────────────────────────────────────────

  private parseExprOrAssignStmt(): A.Stmt {
    const pos = this.pos()

    // mut 수식어
    let isMut = false
    if (this.tok.kind === TK.KW_MUT) { this.next(); isMut = true }

    const expr = this.parseExpr(0)

    // 대입 연산자 확인
    const assignOps = new Set([
      TK.DECL, TK.ASSIGN,
      TK.PLUS_EQ, TK.MINUS_EQ, TK.STAR_EQ, TK.SLASH_EQ, TK.PERCENT_EQ,
    ])

    if (assignOps.has(this.tok.kind)) {
      const op = this.tok.lit
      this.next()
      const value = this.parseExpr(0)
      this.skipSemi()
      return { t: 'assign', target: expr, op, value, isMut, pos } as A.AssignStmt
    }

    // 라벨 (goto label:)
    if (expr.t === 'ident' && this.tok.kind === TK.COLON) {
      this.next()
      return { t: 'label', name: (expr as A.Ident).name, pos } as A.GotoLabel
    }

    this.skipSemi()
    return { t: 'expr_stmt', expr, pos } as A.ExprStmt
  }

  // ──────────────────────────────────────────────────────
  //  표현식 (Pratt 파싱)
  //  V 분석 결과: 우선순위 테이블 PRECEDENCE 사용
  // ──────────────────────────────────────────────────────

  parseExpr(minPrec: number): A.Expr {
    let left = this.parsePrimary()

    while (true) {
      const prec = PRECEDENCE[this.tok.kind] ?? -1
      if (prec <= minPrec) break

      const op  = this.tok.lit
      const pos = this.pos()
      this.next()
      const right = this.parseExpr(prec)  // 우결합: prec (같은 수준도 오른쪽)

      left = { t: 'infix', left, op, right, pos } as A.InfixExpr
    }

    return left
  }

  // ──────────────────────────────────────────────────────
  //  기본 표현식 파싱
  // ──────────────────────────────────────────────────────

  private parsePrimary(): A.Expr {
    const pos = this.pos()

    // ── 단항 연산자 ────────────────────────────────────
    if (this.tok.kind === TK.MINUS || this.tok.kind === TK.BANG ||
        this.tok.kind === TK.TILDE || this.tok.kind === TK.AMP ||
        this.tok.kind === TK.STAR) {
      const op = this.tok.lit
      this.next()
      const expr = this.parsePrimary()
      return { t: 'prefix', op, expr, pos } as A.PrefixExpr
    }

    // ── 리터럴 ────────────────────────────────────────
    if (this.tok.kind === TK.NUMBER)  return this.parseNumber()
    if (this.tok.kind === TK.STRING)  return this.parseString()
    if (this.tok.kind === TK.CHAR) {
      const lit = this.tok.lit; this.next()
      return { t: 'char', val: lit, pos } as A.CharLit
    }
    if (this.tok.kind === TK.KW_TRUE)  { this.next(); return { t: 'bool', val: true,  pos } }
    if (this.tok.kind === TK.KW_FALSE) { this.next(); return { t: 'bool', val: false, pos } }
    if (this.tok.kind === TK.KW_NONE || this.tok.kind === TK.KW_NIL) {
      this.next(); return { t: 'none', pos }
    }

    // ── 괄호 ─────────────────────────────────────────
    if (this.tok.kind === TK.LPAREN) {
      this.next()
      const expr = this.parseExpr(0)
      this.expect(TK.RPAREN)
      return { t: 'paren', expr, pos } as A.ParenExpr
    }

    // ── 배열 리터럴 ───────────────────────────────────
    if (this.tok.kind === TK.LBRACKET) return this.parseArrayInit()

    // ── 맵 리터럴 ─────────────────────────────────────
    if (this.tok.kind === TK.LBRACE) return this.parseMapOrBlock()

    // ── 익명 함수 ─────────────────────────────────────
    if (this.tok.kind === TK.KW_FN) return this.parseAnonFn()

    // ── if 표현식 ─────────────────────────────────────
    if (this.tok.kind === TK.KW_IF) return this.parseIfExpr()

    // ── match 표현식 ──────────────────────────────────
    if (this.tok.kind === TK.KW_MATCH) return this.parseMatchExpr()

    // ── sizeof / typeof ───────────────────────────────
    if (this.tok.kind === TK.KW_SIZEOF || this.tok.kind === TK.KW_TYPEOF) {
      const op = this.tok.lit; this.next()
      this.expect(TK.LPAREN)
      const expr = this.parseExpr(0)
      this.expect(TK.RPAREN)
      return { t: 'call', callee: { t: 'ident', name: op, pos }, args: [expr], pos } as A.CallExpr
    }

    // ── enum 단축 .variant ───────────────────────────
    // match subject { .north { } .south { } } 형태에서 사용
    if (this.tok.kind === TK.DOT) {
      this.next()  // .
      const name = this.tok.kind === TK.NAME ? this.tok.lit : this.tok.lit
      this.next()
      // 런타임에 subject 타입에서 해당 variant를 찾아야 함
      // 여기선 '_enum_variant:name' 으로 인코딩
      return { t: 'ident', name: `__enum__.${name}`, pos } as A.Ident
    }

    // ── 식별자 / 타입캐스트 ───────────────────────────
    if (this.tok.kind === TK.NAME) {
      const name = this.tok.lit
      const ipos = this.pos()
      this.next()

      // int(x), f64(n) 등 타입 캐스트
      const builtinTypes = new Set(['int','i8','i16','i32','i64','u8','u16','u32','u64','f32','f64','string','bool','byte','rune'])
      if (builtinTypes.has(name) && this.tok.kind === TK.LPAREN) {
        this.next()
        const expr = this.parseExpr(0)
        this.expect(TK.RPAREN)
        return { t: 'cast', to: name, expr, pos: ipos } as A.CastExpr
      }

      // Struct 초기화: MyStruct{...}
      if (this.tok.kind === TK.LBRACE && name[0] === name[0].toUpperCase()) {
        return this.parseStructInit(name, ipos)
      }

      const ident: A.Ident = { t: 'ident', name, pos: ipos }
      return this.parsePostfix(ident)
    }

    this.error(`예상치 못한 토큰: '${this.tok.lit}'`, pos)
    this.next()
    return { t: 'ident', name: '_err', pos } as A.Ident
  }

  // ── 후위 표현식: 호출, 인덱싱, 필드 접근, or, ++/-- ──

  private parsePostfix(base: A.Expr): A.Expr {
    let expr = base

    while (true) {
      const pos = this.pos()

      // 함수 호출 foo(args)
      if (this.tok.kind === TK.LPAREN) {
        this.next()
        const args = this.parseArgList()
        this.expect(TK.RPAREN)
        expr = { t: 'call', callee: expr, args, pos } as A.CallExpr

        // or 블록
        if (this.tok.kind === TK.KW_OR) {
          this.next()
          const body = this.parseBlock()
          expr = { t: 'or', expr, body, pos } as A.OrExpr
        }
        continue
      }

      // 인덱싱 arr[i]
      if (this.tok.kind === TK.LBRACKET) {
        this.next()
        const index = this.parseExpr(0)
        this.expect(TK.RBRACKET)
        expr = { t: 'index', obj: expr, index, pos } as A.IndexExpr
        continue
      }

      // 필드 접근 obj.field
      if (this.tok.kind === TK.DOT) {
        this.next()
        const field = this.expectName()
        expr = { t: 'selector', obj: expr, field, pos } as A.SelectorExpr
        continue
      }

      // 범위 0..10
      if (this.tok.kind === TK.DOTDOT) {
        this.next()
        const inclusive = this.tok.kind === TK.ASSIGN  // ..=
        if (inclusive) this.next()
        const high = this.parseExpr(0)
        expr = { t: 'range', low: expr, high, inclusive, pos } as A.RangeExpr
        break
      }

      // 후위 ++ / --
      if (this.tok.kind === TK.INC || this.tok.kind === TK.DEC) {
        const op = this.tok.lit; this.next()
        expr = { t: 'postfix', op, expr, pos } as A.PostfixExpr
        continue
      }

      break
    }

    return expr
  }

  // ──────────────────────────────────────────────────────
  //  숫자 리터럴 파싱
  // ──────────────────────────────────────────────────────

  private parseNumber(): A.Expr {
    const pos = this.pos()
    const lit = this.tok.lit; this.next()
    const clean = lit.replace(/_/g, '')

    if (clean.includes('.') || clean.includes('e') || clean.includes('E')) {
      return { t: 'float', val: parseFloat(clean), pos } as A.FloatLit
    }

    let n: bigint
    if (clean.startsWith('0x') || clean.startsWith('0X'))
      n = BigInt(clean)
    else if (clean.startsWith('0b') || clean.startsWith('0B'))
      n = BigInt(clean)
    else if (clean.startsWith('0o') || clean.startsWith('0O'))
      n = BigInt(clean.replace('0o','0').replace('0O','0'))
    else
      n = BigInt(clean)

    return { t: 'int', val: n, pos } as A.IntLit
  }

  // ──────────────────────────────────────────────────────
  //  문자열 리터럴 (보간 처리)
  // ──────────────────────────────────────────────────────

  private parseString(): A.StringLit {
    const pos = this.pos()
    const raw = this.tok.lit; this.next()

    const segments: A.StringLit['segments'] = []
    const parts = raw.split('\x00')

    for (const part of parts) {
      if (part === '') continue
      if (part.startsWith('INTERP:')) {
        const src = part.slice(7)
        // 간단한 식별자 보간 $name
        const innerTokens = new Lexer(src).scanAll()
        const innerParser = new Parser(innerTokens)
        const expr = innerParser.parseExpr(0)
        segments.push({ kind: 'interp', expr })
      } else {
        segments.push({ kind: 'text', text: part })
      }
    }

    return { t: 'string', segments, pos }
  }

  // ──────────────────────────────────────────────────────
  //  배열 리터럴 [1, 2, 3]
  // ──────────────────────────────────────────────────────

  private parseArrayInit(): A.ArrayInit {
    const pos = this.pos()
    this.expect(TK.LBRACKET)
    const elems: A.Expr[] = []

    while (this.tok.kind !== TK.RBRACKET && this.tok.kind !== TK.EOF) {
      elems.push(this.parseExpr(0))
      if (this.tok.kind === TK.COMMA) this.next()
      else break
    }

    this.expect(TK.RBRACKET)
    return { t: 'array', elems, pos }
  }

  // ──────────────────────────────────────────────────────
  //  맵 리터럴 {'a': 1} or 블록 {} 구분
  // ──────────────────────────────────────────────────────

  private parseMapOrBlock(): A.MapInit | A.Block {
    // 빈 {} → 빈 맵
    // {'key': val} → 맵 (peek이 STRING이면 맵)
    // {stmt...}    → 블록
    const pos = this.pos()

    // 빈 중괄호 → 빈 맵
    if (this.peek.kind === TK.RBRACE) {
      this.next(); this.next()
      return { t: 'map', pairs: [], pos }
    }

    // peek이 STRING 또는 NUMBER → 맵 리터럴
    if (this.peek.kind === TK.STRING || this.peek.kind === TK.NUMBER) {
      return this.parseMapLiteral(pos)
    }

    return this.parseBlock()
  }

  private parseMapLiteral(pos: A.Pos): A.MapInit {
    this.expect(TK.LBRACE)
    const pairs: Array<{ key: A.Expr; val: A.Expr }> = []

    while (this.tok.kind !== TK.RBRACE && this.tok.kind !== TK.EOF) {
      const key = this.parsePrimary()
      this.expect(TK.COLON)
      const val = this.parseExpr(0)
      pairs.push({ key, val })
      if (this.tok.kind === TK.COMMA) this.next()
    }

    this.expect(TK.RBRACE)
    return { t: 'map', pairs, pos }
  }

  // ──────────────────────────────────────────────────────
  //  구조체 초기화 Foo{field: val}
  // ──────────────────────────────────────────────────────

  private parseStructInit(name: string, pos: A.Pos): A.StructInit {
    this.expect(TK.LBRACE)
    const fields: Array<{ name: string; val: A.Expr }> = []

    while (this.tok.kind !== TK.RBRACE && this.tok.kind !== TK.EOF) {
      const fieldName = this.expectName()
      this.expect(TK.COLON)
      const val = this.parseExpr(0)
      fields.push({ name: fieldName, val })
      if (this.tok.kind === TK.COMMA) this.next()
    }

    this.expect(TK.RBRACE)
    return { t: 'struct_init', name, fields, pos }
  }

  // ──────────────────────────────────────────────────────
  //  if 표현식
  // ──────────────────────────────────────────────────────

  private parseIfExpr(): A.IfExpr {
    const pos = this.pos()
    const branches: A.IfBranch[] = []

    this.expect(TK.KW_IF)
    branches.push(this.parseIfBranch())

    while (this.tok.kind === TK.KW_ELSE) {
      this.next()
      if (this.tok.kind === TK.KW_IF) {
        this.next()
        branches.push(this.parseIfBranch())
      } else {
        // else 브랜치
        const body = this.parseBlock()
        branches.push({ body })
        break
      }
    }

    return { t: 'if', branches, pos }
  }

  private parseIfBranch(): A.IfBranch {
    // if x := opt_fn() 가드 패턴
    if (this.tok.kind === TK.NAME && this.peek.kind === TK.DECL) {
      const varName = this.tok.lit; this.next(); this.next()
      const expr = this.parseExpr(0)
      const body = this.parseBlock()
      return { guard: { varName, expr }, body }
    }

    const cond = this.parseExpr(0)
    const body = this.parseBlock()
    return { cond, body }
  }

  // ──────────────────────────────────────────────────────
  //  match 표현식
  // ──────────────────────────────────────────────────────

  private parseMatchExpr(): A.MatchExpr {
    const pos = this.pos()
    this.expect(TK.KW_MATCH)
    const subject = this.parseExpr(0)
    this.expect(TK.LBRACE)

    const arms: A.MatchArm[] = []

    while (this.tok.kind !== TK.RBRACE && this.tok.kind !== TK.EOF) {
      const patterns: A.Expr[] = []

      if (this.tok.kind === TK.KW_ELSE) {
        this.next()  // else 브랜치
      } else {
        patterns.push(this.parseExpr(0))
        while (this.tok.kind === TK.COMMA) {
          this.next()
          patterns.push(this.parseExpr(0))
        }
      }

      const body = this.parseBlock()
      arms.push({ patterns, body })
    }

    this.expect(TK.RBRACE)
    return { t: 'match', subject, arms, pos }
  }

  // ──────────────────────────────────────────────────────
  //  함수 선언
  // ──────────────────────────────────────────────────────

  private parseFnDecl(isPub: boolean): A.FnDecl {
    const pos = this.pos()
    this.expect(TK.KW_FN)

    // 메서드 리시버: fn (mut u User) greet()
    let receiver: A.Receiver | undefined
    if (this.tok.kind === TK.LPAREN) {
      this.next()
      const isMut = this.tok.kind === TK.KW_MUT ? (this.next(), true) : false
      const rName = this.expectName()
      const rType = this.expectName()
      this.expect(TK.RPAREN)
      receiver = { name: rName, isMut, type: rType }
    }

    const name = this.expectName()
    const params = this.parseParamList()
    const ret = this.parseReturnType()

    const prevInsideFn = this.insideFn
    this.insideFn = true
    const body = this.parseBlock()
    this.insideFn = prevInsideFn

    return { t: 'fn_decl', name, receiver, params, ret, body, isPub, pos }
  }

  private parseAnonFn(): A.AnonFn {
    const pos = this.pos()
    this.expect(TK.KW_FN)
    const params = this.parseParamList()
    const ret = this.parseReturnType()
    const body = this.parseBlock()
    return { t: 'anon_fn', params, ret, body, pos }
  }

  private parseParamList(): A.Param[] {
    this.expect(TK.LPAREN)
    const params: A.Param[] = []

    while (this.tok.kind !== TK.RPAREN && this.tok.kind !== TK.EOF) {
      const isMut = this.tok.kind === TK.KW_MUT ? (this.next(), true) : false
      const isVariadic = this.tok.kind === TK.DOTDOT ? (this.next(), true) : false
      const name = this.expectName()
      const type = this.parseTypeStr()
      params.push({ name, type, isMut, isVariadic })
      if (this.tok.kind === TK.COMMA) this.next()
    }

    this.expect(TK.RPAREN)
    return params
  }

  private parseReturnType(): string | null {
    // 반환 타입이 없으면 null
    if (this.tok.kind === TK.LBRACE || this.tok.kind === TK.EOF) return null
    return this.parseTypeStr()
  }

  // 타입 문자열 파싱 (간단 버전)
  private parseTypeStr(): string {
    let result = ''

    // ?optional
    if (this.tok.kind === TK.QUESTION) { this.next(); result = '?' }
    // !result
    if (this.tok.kind === TK.BANG)     { this.next(); result = '!' }
    // []배열
    if (this.tok.kind === TK.LBRACKET) {
      this.next(); this.expect(TK.RBRACKET)
      result += '[]' + this.parseTypeStr()
      return result
    }
    // &참조
    if (this.tok.kind === TK.AMP) { this.next(); result = '&' }
    // mut
    if (this.tok.kind === TK.KW_MUT) { this.next(); result += 'mut ' }
    // 타입명
    if (this.tok.kind === TK.NAME) { result += this.tok.lit; this.next() }
    else if (this.tok.kind === TK.KW_FN) {
      result += 'fn'; this.next()
      // fn(param_types) ret_type 형태 처리
      if (this.tok.kind === TK.LPAREN) {
        this.next() // (
        let depth = 1
        result += '('
        while (this.tok.kind !== TK.EOF && depth > 0) {
          if (this.tok.kind === TK.LPAREN) depth++
          if (this.tok.kind === TK.RPAREN) { depth--; if (depth === 0) break }
          result += this.tok.lit; this.next()
        }
        result += ')'
        this.expect(TK.RPAREN)
        // 반환 타입이 있을 경우
        if (this.tok.kind !== TK.LBRACE && this.tok.kind !== TK.COMMA &&
            this.tok.kind !== TK.RPAREN && this.tok.kind !== TK.EOF) {
          result += ' ' + this.parseTypeStr()
        }
      }
    }

    return result || 'any'
  }

  // ──────────────────────────────────────────────────────
  //  struct 선언
  // ──────────────────────────────────────────────────────

  private parseStructDecl(isPub: boolean): A.StructDecl {
    const pos = this.pos()
    this.expect(TK.KW_STRUCT)
    const name = this.expectName()
    this.expect(TK.LBRACE)
    const fields: A.StructField[] = []

    while (this.tok.kind !== TK.RBRACE && this.tok.kind !== TK.EOF) {
      // pub / mut 수식어
      let fieldIsPub = false, fieldIsMut = false
      if (this.tok.kind === TK.KW_PUB)  { this.next(); fieldIsPub = true }
      if (this.tok.kind === TK.KW_MUT)  { this.next(); fieldIsMut = true; this.expect(TK.COLON) }

      if (this.tok.kind === TK.NAME) {
        const fName = this.tok.lit; this.next()
        const fType = this.parseTypeStr()
        let def: A.Expr | undefined
        if (this.tok.kind === TK.ASSIGN) { this.next(); def = this.parseExpr(0) }
        fields.push({ name: fName, type: fType, isMut: fieldIsMut, isPub: fieldIsPub, default: def })
      }
      this.skipSemi()
    }

    this.expect(TK.RBRACE)
    return { t: 'struct_decl', name, fields, isPub, pos }
  }

  // ──────────────────────────────────────────────────────
  //  interface 선언
  // ──────────────────────────────────────────────────────

  private parseInterfaceDecl(isPub: boolean): A.InterfaceDecl {
    const pos = this.pos()
    this.expect(TK.KW_INTERFACE)
    const name = this.expectName()
    this.expect(TK.LBRACE)
    const methods: A.InterfaceMethod[] = []

    while (this.tok.kind !== TK.RBRACE && this.tok.kind !== TK.EOF) {
      if (this.tok.kind === TK.NAME) {
        const mName = this.tok.lit; this.next()
        const params = this.parseParamList()
        const ret = this.parseReturnType()
        methods.push({ name: mName, params, ret })
      }
      this.skipSemi()
    }

    this.expect(TK.RBRACE)
    return { t: 'interface_decl', name, methods, isPub, pos }
  }

  // ──────────────────────────────────────────────────────
  //  enum 선언
  // ──────────────────────────────────────────────────────

  private parseEnumDecl(isPub: boolean): A.EnumDecl {
    const pos = this.pos()
    this.expect(TK.KW_ENUM)
    const name = this.expectName()
    this.expect(TK.LBRACE)
    const values: Array<{ name: string; value?: A.Expr }> = []

    while (this.tok.kind !== TK.RBRACE && this.tok.kind !== TK.EOF) {
      if (this.tok.kind === TK.NAME) {
        const vName = this.tok.lit; this.next()
        let val: A.Expr | undefined
        if (this.tok.kind === TK.ASSIGN) { this.next(); val = this.parseExpr(0) }
        values.push({ name: vName, value: val })
      }
      this.skipSemi()
    }

    this.expect(TK.RBRACE)
    return { t: 'enum_decl', name, values, isPub, pos }
  }

  // ──────────────────────────────────────────────────────
  //  나머지 선언들
  // ──────────────────────────────────────────────────────

  private parseTypeDecl(isPub: boolean): A.TypeDecl {
    const pos = this.pos()
    this.expect(TK.KW_TYPE)
    const name = this.expectName()
    this.expect(TK.ASSIGN)
    const alias = this.parseTypeStr()
    return { t: 'type_decl', name, alias, isPub, pos }
  }

  private parseConstDecl(isPub: boolean): A.ConstDecl {
    const pos = this.pos()
    this.expect(TK.KW_CONST)
    const name = this.expectName()
    this.expect(TK.ASSIGN)
    const value = this.parseExpr(0)
    this.skipSemi()
    return { t: 'const_decl', name, value, isPub, pos }
  }

  private parseImport(): A.ImportStmt {
    const pos = this.pos()
    this.expect(TK.KW_IMPORT)
    let path = this.expectName()
    // import v.math → 점으로 구분된 경로
    while (this.tok.kind === TK.DOT) {
      this.next(); path += '.' + this.expectName()
    }
    let alias: string | undefined
    if (this.tok.kind === TK.KW_AS) { this.next(); alias = this.expectName() }
    return { t: 'import', path, alias, pos }
  }

  // ──────────────────────────────────────────────────────
  //  for 루프 (V: 3가지 형태)
  // ──────────────────────────────────────────────────────

  private parseFor(): A.Stmt {
    const pos = this.pos()
    this.expect(TK.KW_FOR)
    const prevInsideFor = this.insideFor
    this.insideFor = true

    let stmt: A.Stmt

    // for {} 무한 루프
    if (this.tok.kind === TK.LBRACE) {
      const body = this.parseBlock()
      stmt = { t: 'for', cond: null, body, pos } as A.ForStmt
    }
    // for x in iterable {} or for i, x in iterable {}
    else if (this.isForIn()) {
      stmt = this.parseForIn(pos)
    }
    // for i := 0; i < n; i++ {} (C 스타일)
    else if (this.peek.kind === TK.DECL) {
      stmt = this.parseForC(pos)
    }
    // for cond {} (while 스타일)
    else {
      const cond = this.parseExpr(0)
      const body = this.parseBlock()
      stmt = { t: 'for', cond, body, pos } as A.ForStmt
    }

    this.insideFor = prevInsideFor
    return stmt
  }

  // for i, x in arr 또는 for x in arr 감지
  private isForIn(): boolean {
    // tok=NAME, peek=IN → for x in
    if (this.tok.kind === TK.NAME && this.peek.kind === TK.KW_IN) return true
    // tok=NAME, peek=COMMA → for i, x in (미래 2토큰 더 봐야 함)
    // 간단히: tok=NAME, peek=COMMA 인 경우
    if (this.tok.kind === TK.NAME && this.peek.kind === TK.COMMA) return true
    return false
  }

  private parseForIn(pos: A.Pos): A.ForInStmt {
    let keyVar: string | null = null
    let valVar: string

    valVar = this.expectName()

    // for i, v in ...
    if (this.tok.kind === TK.COMMA) {
      this.next()
      keyVar = valVar
      valVar = this.expectName()
    }

    this.expect(TK.KW_IN)
    const iterable = this.parseExpr(0)
    const body = this.parseBlock()
    return { t: 'for_in', keyVar, valVar, iterable, body, pos }
  }

  private parseForC(pos: A.Pos): A.ForCStmt {
    // init
    const mut = this.tok.kind === TK.KW_MUT ? (this.next(), true) : false
    const initExpr = this.parseExpr(0)
    this.expect(TK.DECL)
    const initVal = this.parseExpr(0)
    const init: A.AssignStmt = { t: 'assign', target: initExpr, op: ':=', value: initVal, isMut: mut, pos }
    this.expect(TK.SEMICOLON)

    // cond
    const cond = this.parseExpr(0)
    this.expect(TK.SEMICOLON)

    // post (보통 i++)
    const postExpr = this.parseExprOrAssignStmt()
    const body = this.parseBlock()
    return { t: 'for_c', init, cond, post: postExpr, body, pos }
  }

  // ──────────────────────────────────────────────────────
  //  나머지 문장들
  // ──────────────────────────────────────────────────────

  private parseReturn(): A.Return {
    const pos = this.pos()
    this.expect(TK.KW_RETURN)
    let value: A.Expr | null = null
    if (this.tok.kind !== TK.RBRACE && this.tok.kind !== TK.SEMICOLON && this.tok.kind !== TK.EOF)
      value = this.parseExpr(0)
    this.skipSemi()
    return { t: 'return', value, pos }
  }

  private parseBranch(kind: 'break' | 'continue'): A.BranchStmt {
    const pos = this.pos(); this.next()
    let label: string | null = null
    if (this.tok.kind === TK.NAME) { label = this.tok.lit; this.next() }
    return { t: 'branch', kind, label, pos }
  }

  private parseDefer(): A.DeferStmt {
    const pos = this.pos(); this.expect(TK.KW_DEFER)
    const body = this.parseBlock()
    return { t: 'defer', body, pos }
  }

  private parseAssert(): A.AssertStmt {
    const pos = this.pos(); this.expect(TK.KW_ASSERT)
    const cond = this.parseExpr(0)
    let msg: A.Expr | undefined
    if (this.tok.kind === TK.COMMA) { this.next(); msg = this.parseExpr(0) }
    this.skipSemi()
    return { t: 'assert', cond, msg, pos }
  }

  parseBlock(): A.Block {
    const pos = this.pos()
    this.expect(TK.LBRACE)
    const stmts: A.Stmt[] = []

    while (this.tok.kind !== TK.RBRACE && this.tok.kind !== TK.EOF) {
      stmts.push(this.parseStmt())
    }

    this.expect(TK.RBRACE)
    return { t: 'block', stmts, pos }
  }

  private parseArgList(): A.Expr[] {
    const args: A.Expr[] = []
    while (this.tok.kind !== TK.RPAREN && this.tok.kind !== TK.EOF) {
      // mut 전달: foo(mut x)
      if (this.tok.kind === TK.KW_MUT) this.next()
      args.push(this.parseExpr(0))
      if (this.tok.kind === TK.COMMA) this.next()
      else break
    }
    return args
  }

  // ──────────────────────────────────────────────────────
  //  유틸리티
  // ──────────────────────────────────────────────────────

  private next(): Token {
    const cur = this.tok
    this.tok  = this.peek
    this.peek = this.tokens[this.tidx] ?? this.eofToken()
    this.tidx++
    return cur
  }

  private expect(kind: TK): Token {
    if (this.tok.kind !== kind) {
      this.error(`'${TK[kind]}' 기대, '${this.tok.lit}' 발견`, this.pos())
    }
    return this.next()
  }

  private expectName(): string {
    if (this.tok.kind !== TK.NAME) {
      this.error(`식별자 기대, '${this.tok.lit}' 발견`, this.pos())
      return '_'
    }
    return this.next().lit
  }

  private skipSemi(): void {
    while (this.tok.kind === TK.SEMICOLON) this.next()
  }

  private pos(): A.Pos { return { line: this.tok.line, col: this.tok.col } }

  private eofToken(): Token {
    return { kind: TK.EOF, lit: '', line: 0, col: 0, pos: 0 }
  }

  private error(msg: string, pos: A.Pos): void {
    this.errors.push({ msg, line: pos.line, col: pos.col })
  }
}
