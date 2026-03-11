// V 언어 토큰 정의
// 분석 결과: V는 140개 토큰. 여기선 핵심 서브셋으로 구현.

export enum TK {
  // ── 특수 ──────────────────────────────────
  EOF = 0,
  ERROR,

  // ── 값 토큰 ──────────────────────────────
  NAME,       // 식별자
  NUMBER,     // 정수/실수
  STRING,     // 'hello', "world"
  CHAR,       // `A`

  // ── 단항/이항 연산자 ──────────────────────
  PLUS,       // +
  MINUS,      // -
  STAR,       // *
  SLASH,      // /
  PERCENT,    // %

  INC,        // ++
  DEC,        // --

  AMP,        // &
  PIPE,       // |
  CARET,      // ^
  TILDE,      // ~
  SHL,        // <<
  SHR,        // >>

  // ── 비교 ─────────────────────────────────
  EQ,         // ==
  NE,         // !=
  LT,         // <
  GT,         // >
  LE,         // <=
  GE,         // >=

  // ── 논리 ─────────────────────────────────
  AND,        // &&
  OR,         // ||
  BANG,       // !

  // ── 할당 ─────────────────────────────────
  ASSIGN,     // =
  DECL,       // :=
  PLUS_EQ,    // +=
  MINUS_EQ,   // -=
  STAR_EQ,    // *=
  SLASH_EQ,   // /=
  PERCENT_EQ, // %=

  // ── 구조 문자 ─────────────────────────────
  LPAREN,     // (
  RPAREN,     // )
  LBRACE,     // {
  RBRACE,     // }
  LBRACKET,   // [
  RBRACKET,   // ]

  COMMA,      // ,
  COLON,      // :
  SEMICOLON,  // ;
  DOT,        // .
  DOTDOT,     // ..
  ARROW,      // <-  (채널)
  QUESTION,   // ?
  AT,         // @
  HASH,       // #
  DOLLAR,     // $  (문자열 보간)

  // ── 키워드 (keyword_beg 이후) ──────────────
  KW_FN,
  KW_IF,
  KW_ELSE,
  KW_FOR,
  KW_IN,
  KW_RETURN,
  KW_MATCH,
  KW_STRUCT,
  KW_INTERFACE,
  KW_ENUM,
  KW_TYPE,
  KW_MUT,
  KW_PUB,
  KW_CONST,
  KW_IMPORT,
  KW_MODULE,
  KW_TRUE,
  KW_FALSE,
  KW_NONE,
  KW_OR,
  KW_BREAK,
  KW_CONTINUE,
  KW_DEFER,
  KW_GO,
  KW_SPAWN,
  KW_IS,
  KW_AS,
  KW_UNSAFE,
  KW_GOTO,
  KW_ASSERT,
  KW_NIL,
  KW_SHARED,
  KW_LOCK,
  KW_RLOCK,
  KW_SELECT,
  KW_STATIC,
  KW_ATOMIC,
  KW_SIZEOF,
  KW_TYPEOF,
  KW_DUMP,
}

// 토큰 하나를 표현하는 구조체
// V의 Token 구조체와 동일: kind, lit, line, col, pos
export interface Token {
  kind: TK
  lit:  string   // 원본 텍스트
  line: number
  col:  number
  pos:  number   // 파일 내 절대 위치
}

// 키워드 → TK 매핑 (V처럼 Object.create(null)로 프로토타입 오염 차단)
export const KEYWORDS: Record<string, TK> = Object.create(null)
KEYWORDS['fn']        = TK.KW_FN
KEYWORDS['if']        = TK.KW_IF
KEYWORDS['else']      = TK.KW_ELSE
KEYWORDS['for']       = TK.KW_FOR
KEYWORDS['in']        = TK.KW_IN
KEYWORDS['return']    = TK.KW_RETURN
KEYWORDS['match']     = TK.KW_MATCH
KEYWORDS['struct']    = TK.KW_STRUCT
KEYWORDS['interface'] = TK.KW_INTERFACE
KEYWORDS['enum']      = TK.KW_ENUM
KEYWORDS['type']      = TK.KW_TYPE
KEYWORDS['mut']       = TK.KW_MUT
KEYWORDS['pub']       = TK.KW_PUB
KEYWORDS['const']     = TK.KW_CONST
KEYWORDS['import']    = TK.KW_IMPORT
KEYWORDS['module']    = TK.KW_MODULE
KEYWORDS['true']      = TK.KW_TRUE
KEYWORDS['false']     = TK.KW_FALSE
KEYWORDS['none']      = TK.KW_NONE
KEYWORDS['or']        = TK.KW_OR
KEYWORDS['break']     = TK.KW_BREAK
KEYWORDS['continue']  = TK.KW_CONTINUE
KEYWORDS['defer']     = TK.KW_DEFER
KEYWORDS['go']        = TK.KW_GO
KEYWORDS['spawn']     = TK.KW_SPAWN
KEYWORDS['is']        = TK.KW_IS
KEYWORDS['as']        = TK.KW_AS
KEYWORDS['unsafe']    = TK.KW_UNSAFE
KEYWORDS['goto']      = TK.KW_GOTO
KEYWORDS['assert']    = TK.KW_ASSERT
KEYWORDS['nil']       = TK.KW_NIL
KEYWORDS['shared']    = TK.KW_SHARED
KEYWORDS['lock']      = TK.KW_LOCK
KEYWORDS['rlock']     = TK.KW_RLOCK
KEYWORDS['select']    = TK.KW_SELECT
KEYWORDS['static']    = TK.KW_STATIC
KEYWORDS['atomic']    = TK.KW_ATOMIC
KEYWORDS['sizeof']    = TK.KW_SIZEOF
KEYWORDS['typeof']    = TK.KW_TYPEOF

// 연산자 우선순위 테이블 (V의 token.v 우선순위와 동일)
export const PRECEDENCE: Partial<Record<TK, number>> = {
  [TK.OR]:      1,  // ||
  [TK.AND]:     2,  // &&
  [TK.PIPE]:    3,  // |
  [TK.CARET]:   4,  // ^
  [TK.AMP]:     5,  // &
  [TK.EQ]:      6,  [TK.NE]:  6,  // == !=
  [TK.KW_IN]:   6,  [TK.KW_IS]: 6,  // in, is
  [TK.LT]:      7,  [TK.GT]:  7,  [TK.LE]: 7,  [TK.GE]: 7,
  [TK.SHL]:     8,  [TK.SHR]: 8,
  [TK.PLUS]:    9,  [TK.MINUS]: 9,
  [TK.STAR]:   10,  [TK.SLASH]: 10, [TK.PERCENT]: 10,
}

export function kindName(k: TK): string {
  return TK[k] ?? `TK(${k})`
}
