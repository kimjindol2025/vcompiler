// V 언어 AST 노드 정의
// V 분석에서 배운 패턴:
//   - Expr / Stmt 를 discriminated union으로 정의
//   - 각 노드에 pos(위치) 포함
//   - 필요한 곳에 optional 타입 정보 필드

export interface Pos { line: number; col: number }

// ══════════════════════════════════════════════════════════
//  Expr — 표현식 (값을 생성하는 것)
// ══════════════════════════════════════════════════════════

export type Expr =
  | IntLit       // 42
  | FloatLit     // 3.14
  | StringLit    // 'hello $name'
  | CharLit      // `A`
  | BoolLit      // true / false
  | NoneLit      // none
  | Ident        // x, foo
  | InfixExpr    // a + b
  | PrefixExpr   // -x, !x, &x, *x
  | PostfixExpr  // x++, x--
  | CallExpr     // foo(a, b)
  | IndexExpr    // arr[i]
  | SelectorExpr // obj.field
  | ArrayInit    // [1, 2, 3]
  | MapInit      // {'a': 1}
  | StructInit   // Foo{name: 'kim'}
  | IfExpr       // if cond { a } else { b }
  | MatchExpr    // match x { 1 { } }
  | OrExpr       // val or { default }
  | CastExpr     // int(x)
  | RangeExpr    // 0..10
  | AnonFn       // fn(x int) int { x * 2 }
  | ParenExpr    // (expr)

export interface IntLit      { t: 'int';    val: bigint;  pos: Pos }
export interface FloatLit    { t: 'float';  val: number;  pos: Pos }
export interface CharLit     { t: 'char';   val: string;  pos: Pos }
export interface BoolLit     { t: 'bool';   val: boolean; pos: Pos }
export interface NoneLit     { t: 'none';                 pos: Pos }
export interface ParenExpr   { t: 'paren';  expr: Expr;  pos: Pos }

// 문자열: segments 배열 (일반 텍스트 + 보간 표현식 교차)
export interface StringLit {
  t: 'string'
  segments: Array<{ kind: 'text'; text: string } | { kind: 'interp'; expr: Expr }>
  pos: Pos
}

// 식별자: 변수명, 함수명 등
export interface Ident {
  t: 'ident'
  name: string
  // 체커가 나중에 채우는 타입 정보 (옵션)
  resolvedType?: VType
  pos: Pos
}

// 이항 연산: left op right
export interface InfixExpr {
  t: 'infix'
  left:  Expr
  op:    string  // '+', '-', '==', ...
  right: Expr
  pos:   Pos
}

// 단항 연산: op expr
export interface PrefixExpr {
  t: 'prefix'
  op:   string  // '-', '!', '&', '*', '~'
  expr: Expr
  pos:  Pos
}

// 후위 연산: expr++, expr--
export interface PostfixExpr {
  t: 'postfix'
  op:   string  // '++', '--'
  expr: Expr
  pos:  Pos
}

// 함수 호출
export interface CallExpr {
  t: 'call'
  callee:  Expr          // 보통 Ident 또는 SelectorExpr
  args:    Expr[]
  // or 블록: foo() or { default }
  orBlock?: Block
  pos: Pos
}

// 배열 인덱싱 arr[i]
export interface IndexExpr {
  t: 'index'
  obj:   Expr
  index: Expr
  pos:   Pos
}

// 필드 접근 obj.field
export interface SelectorExpr {
  t: 'selector'
  obj:   Expr
  field: string
  pos:   Pos
}

// 배열 리터럴 [1, 2, 3]
export interface ArrayInit {
  t:    'array'
  elems: Expr[]
  pos:  Pos
}

// 맵 리터럴 {'a': 1, 'b': 2}
export interface MapInit {
  t:     'map'
  pairs: Array<{ key: Expr; val: Expr }>
  pos:   Pos
}

// 구조체 초기화 Foo{name: 'kim', age: 30}
export interface StructInit {
  t:      'struct_init'
  name:   string
  fields: Array<{ name: string; val: Expr }>
  pos:    Pos
}

// if 표현식 (V에서 if는 표현식으로도 쓰임)
export interface IfExpr {
  t:        'if'
  branches: IfBranch[]
  pos:      Pos
}

export interface IfBranch {
  // cond가 없으면 else 브랜치
  cond?: Expr
  body:  Block
  // if x := opt_fn() 형태의 guard
  guard?: { varName: string; expr: Expr }
}

// match 표현식
export interface MatchExpr {
  t:       'match'
  subject: Expr
  arms:    MatchArm[]
  pos:     Pos
}

export interface MatchArm {
  // patterns가 빈 배열이면 else 브랜치
  patterns: Expr[]
  body:     Block
}

// or 블록: expr or { fallback }
export interface OrExpr {
  t:    'or'
  expr: Expr
  body: Block
  pos:  Pos
}

// 타입 변환 int(x), f64(n)
export interface CastExpr {
  t:    'cast'
  to:   string
  expr: Expr
  pos:  Pos
}

// 범위 표현식 0..10
export interface RangeExpr {
  t:         'range'
  low:       Expr
  high:      Expr
  inclusive: boolean  // ..= 이면 true
  pos:       Pos
}

// 익명 함수 fn(x int) int { x * 2 }
export interface AnonFn {
  t:      'anon_fn'
  params: Param[]
  ret:    string | null
  body:   Block
  pos:    Pos
}

// ══════════════════════════════════════════════════════════
//  Stmt — 문장 (실행 흐름을 제어하는 것)
// ══════════════════════════════════════════════════════════

export type Stmt =
  | ExprStmt      // 표현식 문
  | AssignStmt    // x := 1, x = 2, x += 3
  | FnDecl        // fn foo(x int) int {}
  | StructDecl    // struct User { name string }
  | InterfaceDecl // interface Drawable { draw() }
  | EnumDecl      // enum Color { Red Green Blue }
  | TypeDecl      // type ID = int
  | ConstDecl     // const pi = 3.14
  | ForCStmt      // for i := 0; i < n; i++ {}
  | ForInStmt     // for x in arr {}
  | ForStmt       // for {} (무한 루프 or while)
  | Return        // return val
  | Block         // { ... }
  | BranchStmt    // break / continue
  | GotoLabel     // label:
  | GotoStmt      // goto label
  | DeferStmt     // defer { ... }
  | ImportStmt    // import os
  | ModuleStmt    // module main
  | AssertStmt    // assert cond, 'msg'

// 표현식 문장 (보통 함수 호출)
export interface ExprStmt {
  t:    'expr_stmt'
  expr: Expr
  pos:  Pos
}

// 대입/선언
// op: ':=' (선언), '=' (대입), '+=' 등
export interface AssignStmt {
  t:      'assign'
  target: Expr       // 좌변 (Ident, IndexExpr, SelectorExpr)
  op:     string
  value:  Expr
  isMut:  boolean    // mut x := ...
  pos:    Pos
}

// 함수 선언
export interface FnDecl {
  t:         'fn_decl'
  name:      string
  receiver?: Receiver   // 메서드 리시버 (mut rec Type)
  params:    Param[]
  ret:       string | null  // 반환 타입 문자열
  body:      Block
  isPub:     boolean
  pos:       Pos
}

export interface Receiver {
  name:  string
  isMut: boolean
  type:  string
}

export interface Param {
  name:   string
  type:   string
  isMut:  boolean
  isVariadic: boolean  // ...int
}

// 구조체 선언
export interface StructDecl {
  t:      'struct_decl'
  name:   string
  fields: StructField[]
  isPub:  boolean
  pos:    Pos
}

export interface StructField {
  name:    string
  type:    string
  isMut:   boolean
  isPub:   boolean
  default?: Expr
}

// 인터페이스 선언
export interface InterfaceDecl {
  t:       'interface_decl'
  name:    string
  methods: InterfaceMethod[]
  isPub:   boolean
  pos:     Pos
}

export interface InterfaceMethod {
  name:   string
  params: Param[]
  ret:    string | null
}

// 열거형
export interface EnumDecl {
  t:      'enum_decl'
  name:   string
  values: Array<{ name: string; value?: Expr }>
  isPub:  boolean
  pos:    Pos
}

// 타입 별칭
export interface TypeDecl {
  t:     'type_decl'
  name:  string
  alias: string
  isPub: boolean
  pos:   Pos
}

// 상수
export interface ConstDecl {
  t:     'const_decl'
  name:  string
  value: Expr
  isPub: boolean
  pos:   Pos
}

// for i := 0; i < n; i++ {}
export interface ForCStmt {
  t:     'for_c'
  init:  AssignStmt | null
  cond:  Expr | null
  post:  Stmt | null
  body:  Block
  pos:   Pos
}

// for x in arr {} / for i, x in arr {}
export interface ForInStmt {
  t:        'for_in'
  keyVar:   string | null  // i (인덱스 변수)
  valVar:   string         // x (값 변수)
  iterable: Expr
  body:     Block
  pos:      Pos
}

// for cond {} or for {}
export interface ForStmt {
  t:    'for'
  cond: Expr | null  // null이면 무한 루프
  body: Block
  pos:  Pos
}

// return [expr]
export interface Return {
  t:     'return'
  value: Expr | null
  pos:   Pos
}

// { stmts... }
export interface Block {
  t:     'block'
  stmts: Stmt[]
  pos:   Pos
}

// break / continue [label]
export interface BranchStmt {
  t:     'branch'
  kind:  'break' | 'continue'
  label: string | null
  pos:   Pos
}

// goto label
export interface GotoStmt  { t: 'goto';  label: string; pos: Pos }
export interface GotoLabel  { t: 'label'; name:  string; pos: Pos }

// defer { ... }
export interface DeferStmt {
  t:    'defer'
  body: Block
  pos:  Pos
}

// import os / import math { sin, cos }
export interface ImportStmt {
  t:      'import'
  path:   string
  alias?: string
  pos:    Pos
}

// module main
export interface ModuleStmt {
  t:    'module'
  name: string
  pos:  Pos
}

// assert cond [, 'message']
export interface AssertStmt {
  t:    'assert'
  cond: Expr
  msg?: Expr
  pos:  Pos
}

// ══════════════════════════════════════════════════════════
//  최상위 파일 구조
// ══════════════════════════════════════════════════════════

export interface VFile {
  module: string
  stmts:  Stmt[]
}

// ══════════════════════════════════════════════════════════
//  타입 시스템 (단순화)
// ══════════════════════════════════════════════════════════

export type VType =
  | { kind: 'int' }
  | { kind: 'i64' }
  | { kind: 'f32' }
  | { kind: 'f64' }
  | { kind: 'bool' }
  | { kind: 'string' }
  | { kind: 'char' }
  | { kind: 'void' }
  | { kind: 'none' }
  | { kind: 'option'; inner: VType }
  | { kind: 'result'; inner: VType }
  | { kind: 'array';  elem:  VType }
  | { kind: 'map';    key: VType; val: VType }
  | { kind: 'named';  name: string }  // 사용자 정의 구조체/인터페이스
  | { kind: 'fn';     params: VType[]; ret: VType }
  | { kind: 'unknown' }
