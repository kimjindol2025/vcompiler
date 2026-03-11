// IR (Intermediate Representation) — zig-multi-backend 패턴 적용
//
// zig-multi-backend에서 배운 핵심 설계:
//   - 가상 레지스터(VReg): 각 연산 결과에 고유 번호 할당 (SSA 스타일)
//   - 평탄화된 표현식: 재귀 eval 없이 register-based 3-address code
//   - 구조화된 제어흐름: GIMPLE처럼 if/for는 nested blocks 유지
//   - emit* 함수 패턴: 각 연산마다 새 VReg 반환
//
// pipeline: AST → IRGen → IRInst[] (per function) → IRExecutor → runtime

import * as A from './ast.js'

// ─────────────────────────────────────────────────────
//  VReg: zig의 u32 vreg_counter와 동일 개념
// ─────────────────────────────────────────────────────
export type VReg = number

// ─────────────────────────────────────────────────────
//  IRVal: IR 실행 시간 값 (vm.ts의 VVal과 동일 구조)
// ─────────────────────────────────────────────────────
export type IRVal =
  | { v: 'int';     n: bigint }
  | { v: 'float';   f: number }
  | { v: 'bool';    b: boolean }
  | { v: 'string';  s: string }
  | { v: 'char';    c: string }
  | { v: 'array';   elems: IRVal[] }
  | { v: 'map';     entries: Map<string, IRVal> }
  | { v: 'struct';  name: string; fields: Map<string, IRVal> }
  | { v: 'fn';      fn: IRFn; closure: Map<string, IRVal> }
  | { v: 'builtin'; name: string }
  | { v: 'range';   lo: number; hi: number; inc: boolean }
  | { v: 'none' }
  | { v: 'void' }

// ─────────────────────────────────────────────────────
//  IRFn: 컴파일된 함수 정의
// ─────────────────────────────────────────────────────
export interface IRFn {
  name:   string
  params: string[]
  body:   IRInst[]
}

// ─────────────────────────────────────────────────────
//  IRModule: 전체 프로그램
// ─────────────────────────────────────────────────────
export interface IRModule {
  fns:     Map<string, IRFn>
  structs: Map<string, A.StructDecl>
  enums:   Map<string, A.EnumDecl>
  main:    IRInst[]   // 최상위 문장 (fn 밖 코드)
}

// ─────────────────────────────────────────────────────
//  IRInst: 3-address code 명령어
//
//  설계 원칙 (zig-multi-backend 참조):
//   - 표현식은 완전 평탄화 → 가상 레지스터 사용
//   - 제어흐름은 GIMPLE 스타일 nested blocks 유지
//   - 각 명령어는 독립적으로 직렬화/덤프 가능
// ─────────────────────────────────────────────────────
export type IRInst =
  // ── 상수 (zig: emitConst) ──────────────────────────
  | { op: 'CONST';   dst: VReg; val: IRVal }

  // ── 변수 로드/저장 (zig: emitLoad/emitStore) ───────
  | { op: 'LOAD';    dst: VReg; name: string }
  | { op: 'STORE';   name: string; src: VReg; decl: boolean; mut: boolean }

  // ── 이항/단항 연산 (zig: emitAdd/emitSub/emitICmp) ─
  | { op: 'BINOP';   dst: VReg; bop: string; l: VReg; r: VReg }
  | { op: 'UNOP';    dst: VReg; uop: string; src: VReg }
  // ── 단락 평가 (short-circuit &&, ||) ───────────────
  | { op: 'AND';     dst: VReg; l: VReg; rPfx: IRInst[]; r: VReg }
  | { op: 'OR';      dst: VReg; l: VReg; rPfx: IRInst[]; r: VReg }

  // ── 컬렉션 생성 ──────────────────────────────────
  | { op: 'ARRAY';   dst: VReg; elems: VReg[] }
  | { op: 'MAP';     dst: VReg; keys: string[]; vals: VReg[] }
  | { op: 'STRUCT';  dst: VReg; name: string; fields: Array<{ name: string; src: VReg }> }
  | { op: 'RANGE';   dst: VReg; lo: VReg; hi: VReg; inc: boolean }

  // ── 인덱싱/필드 접근 ─────────────────────────────
  | { op: 'GET_IDX'; dst: VReg; obj: VReg; idx: VReg }
  | { op: 'SET_IDX'; obj: VReg; idx: VReg; val: VReg }
  | { op: 'GET_FLD'; dst: VReg; obj: VReg; fld: string }
  | { op: 'SET_FLD'; obj: VReg; fld: string; val: VReg }

  // ── 함수 호출 (zig: emitCall) ──────────────────────
  | { op: 'CALL';    dst: VReg; callee: VReg; args: VReg[] }
  | { op: 'MCALL';   dst: VReg; recv: VReg; method: string; args: VReg[] }

  // ── 문자열 보간 ───────────────────────────────────
  | { op: 'INTERP';  dst: VReg; parts: Array<{ kind: 'text'; text: string } | { kind: 'reg'; src: VReg }> }

  // ── 타입 캐스트 ───────────────────────────────────
  | { op: 'CAST';    dst: VReg; to: string; src: VReg }

  // ── 반환 (zig: emitRet/emitRetVoid) ───────────────
  | { op: 'RET';     val: VReg | null }

  // ── 구조화 제어흐름 (GIMPLE 스타일) ─────────────────
  | { op: 'IF';      cond: VReg; then_: IRInst[]; else_: IRInst[] }
  | { op: 'WHILE';   condPfx: IRInst[]; cond: VReg | null; body: IRInst[] }
  | { op: 'FOR_C';   init: IRInst[]; condPfx: IRInst[]; cond: VReg; post: IRInst[]; body: IRInst[] }
  | { op: 'FOR_IN';  valVar: string; keyVar: string | null; iter: VReg; body: IRInst[] }
  | { op: 'MATCH';   subj: VReg; arms: Array<{ pats: VReg[]; body: IRInst[] }> }
  | { op: 'BLOCK';   body: IRInst[] }

  // ── 분기 제어 ─────────────────────────────────────
  | { op: 'BREAK' }
  | { op: 'CONTINUE' }
  | { op: 'LABEL';   name: string }
  | { op: 'JMP';     label: string }

  // ── 기타 ──────────────────────────────────────────
  | { op: 'DEFER';   body: IRInst[] }
  | { op: 'ASSERT';  cond: VReg; msg: VReg | null }
  | { op: 'POSTFIX'; name: string; pop: string }   // x++, x--

// ═════════════════════════════════════════════════════
//  IRGen: AST → IR 변환기
//  zig-multi-backend의 LLVMIRCodegen 구조를 TypeScript로 적용
// ═════════════════════════════════════════════════════
export class IRGen {
  // zig의 vreg_counter, label_counter와 동일
  private _reg   = 0
  private _label = 0

  // 현재 함수의 명령어 버퍼 (zig의 output ArrayList)
  private _buf: IRInst[] = []

  // 수집된 함수/타입 정의
  readonly fns    = new Map<string, IRFn>()
  readonly structs = new Map<string, A.StructDecl>()
  readonly enums   = new Map<string, A.EnumDecl>()

  // ── zig의 allocVReg() 에 해당 ──────────────────────
  private newReg(): VReg { return this._reg++ }
  private newLabel(pfx = 'L'): string { return `${pfx}${this._label++}` }

  // ── zig의 emit() 에 해당 ──────────────────────────
  private emit(inst: IRInst): void { this._buf.push(inst) }

  // 서브-버퍼 컨텍스트 (함수/defer 컴파일 시 사용)
  private withBuf<T>(fn: () => T): { result: T; insts: IRInst[] } {
    const prev = this._buf
    this._buf = []
    const result = fn()
    const insts = this._buf
    this._buf = prev
    return { result, insts }
  }

  // ─────────────────────────────────────────────────
  //  공개 진입점: VFile → IRModule
  // ─────────────────────────────────────────────────
  genModule(file: A.VFile): IRModule {
    const { insts: main } = this.withBuf(() => {
      for (const stmt of file.stmts) {
        this.genStmt(stmt)
      }
    })
    return { fns: this.fns, structs: this.structs, enums: this.enums, main }
  }

  // ─────────────────────────────────────────────────
  //  표현식 컴파일 → VReg 반환
  //  zig의 emitAdd(lhs, rhs) → u32 패턴과 동일
  // ─────────────────────────────────────────────────
  genExpr(expr: A.Expr): VReg {
    switch (expr.t) {
      case 'int': {
        const dst = this.newReg()
        this.emit({ op: 'CONST', dst, val: { v: 'int', n: expr.val } })
        return dst
      }
      case 'float': {
        const dst = this.newReg()
        this.emit({ op: 'CONST', dst, val: { v: 'float', f: expr.val } })
        return dst
      }
      case 'bool': {
        const dst = this.newReg()
        this.emit({ op: 'CONST', dst, val: { v: 'bool', b: expr.val } })
        return dst
      }
      case 'char': {
        const dst = this.newReg()
        this.emit({ op: 'CONST', dst, val: { v: 'char', c: expr.val } })
        return dst
      }
      case 'none': {
        const dst = this.newReg()
        this.emit({ op: 'CONST', dst, val: { v: 'none' } })
        return dst
      }
      case 'string': {
        const dst = this.newReg()
        if (expr.segments.length === 1 && expr.segments[0].kind === 'text') {
          this.emit({ op: 'CONST', dst, val: { v: 'string', s: expr.segments[0].text } })
        } else {
          const parts: Array<{ kind: 'text'; text: string } | { kind: 'reg'; src: VReg }> = []
          for (const seg of expr.segments) {
            if (seg.kind === 'text') {
              parts.push({ kind: 'text', text: seg.text })
            } else {
              parts.push({ kind: 'reg', src: this.genExpr(seg.expr) })
            }
          }
          this.emit({ op: 'INTERP', dst, parts })
        }
        return dst
      }
      case 'ident': {
        const dst = this.newReg()
        this.emit({ op: 'LOAD', dst, name: expr.name })
        return dst
      }
      case 'paren':
        return this.genExpr(expr.expr)  // 투명하게 내부 expr만 컴파일
      case 'infix': {
        // 단락 평가 (short-circuit)
        if (expr.op === '&&') {
          const dst = this.newReg()
          const l = this.genExpr(expr.left)
          const { insts: rPfx, result: r } = this.withBuf(() => this.genExpr(expr.right))
          this.emit({ op: 'AND', dst, l, rPfx, r })
          return dst
        }
        if (expr.op === '||') {
          const dst = this.newReg()
          const l = this.genExpr(expr.left)
          const { insts: rPfx, result: r } = this.withBuf(() => this.genExpr(expr.right))
          this.emit({ op: 'OR', dst, l, rPfx, r })
          return dst
        }
        const l = this.genExpr(expr.left)
        const r = this.genExpr(expr.right)
        const dst = this.newReg()
        this.emit({ op: 'BINOP', dst, bop: expr.op, l, r })
        return dst
      }
      case 'prefix': {
        const src = this.genExpr(expr.expr)
        const dst = this.newReg()
        this.emit({ op: 'UNOP', dst, uop: expr.op, src })
        return dst
      }
      case 'postfix': {
        // x++ → 현재 값 반환 + 변수 증감 (side-effect)
        const src = this.genExpr(expr.expr)  // 현재 값 (GET_FLD 또는 LOAD)
        const one = this.newReg()
        this.emit({ op: 'CONST', dst: one, val: { v: 'int', n: 1n } })
        const newVal = this.newReg()
        const bop = expr.op === '++' ? '+' : '-'
        this.emit({ op: 'BINOP', dst: newVal, bop, l: src, r: one })

        if (expr.expr.t === 'ident') {
          // 변수 x++: x = x + 1
          this.emit({ op: 'STORE', name: expr.expr.name, src: newVal, decl: false, mut: false })
        } else if (expr.expr.t === 'selector') {
          // 필드 l.pos++: l.pos = l.pos + 1
          const sel = expr.expr as A.SelectorExpr
          const obj = this.genExpr(sel.obj)
          this.emit({ op: 'SET_FLD', obj, fld: sel.field, val: newVal })
        }
        return src  // 원래 값 반환 (post-increment 의미)
      }
      case 'call': {
        const dst = this.newReg()
        if (expr.callee.t === 'selector') {
          const sel = expr.callee as A.SelectorExpr
          const recv = this.genExpr(sel.obj)
          // V의 arr.map/filter/any/all(expr_with_it) — 암묵적 it 람다 변환
          const itMethods = new Set(['map', 'filter', 'any', 'all'])
          if (itMethods.has(sel.field) && expr.args.length === 1 && this._usesIdent(expr.args[0], 'it')) {
            const lambdaArg = this._compileItLambda(expr.args[0])
            this.emit({ op: 'MCALL', dst, recv, method: sel.field, args: [lambdaArg] })
          } else {
            const args = expr.args.map(a => this.genExpr(a))
            this.emit({ op: 'MCALL', dst, recv, method: sel.field, args })
          }
        } else {
          const callee = this.genExpr(expr.callee)
          const args = expr.args.map(a => this.genExpr(a))
          this.emit({ op: 'CALL', dst, callee, args })
        }
        return dst
      }
      case 'index': {
        const obj = this.genExpr(expr.obj)
        const idx = this.genExpr(expr.index)
        const dst = this.newReg()
        this.emit({ op: 'GET_IDX', dst, obj, idx })
        return dst
      }
      case 'selector': {
        const obj = this.genExpr(expr.obj)
        const dst = this.newReg()
        this.emit({ op: 'GET_FLD', dst, obj, fld: expr.field })
        return dst
      }
      case 'array': {
        const elems = expr.elems.map(e => this.genExpr(e))
        const dst = this.newReg()
        this.emit({ op: 'ARRAY', dst, elems })
        return dst
      }
      case 'map': {
        const keys: string[] = []
        const vals: VReg[] = []
        for (const p of expr.pairs) {
          keys.push(this._exprToKey(p.key))
          vals.push(this.genExpr(p.val))
        }
        const dst = this.newReg()
        this.emit({ op: 'MAP', dst, keys, vals })
        return dst
      }
      case 'struct_init': {
        const fields = expr.fields.map(f => ({ name: f.name, src: this.genExpr(f.val) }))
        const dst = this.newReg()
        this.emit({ op: 'STRUCT', dst, name: expr.name, fields })
        return dst
      }
      case 'range': {
        const lo = this.genExpr(expr.low)
        // __range_end__: s[5..] 같은 open-ended range → hi = -1 sentinel
        let hi: VReg
        if (expr.high.t === 'ident' && (expr.high as any).name === '__range_end__') {
          hi = this.newReg()
          this.emit({ op: 'CONST', dst: hi, val: { v: 'int', n: -1n } })
        } else {
          hi = this.genExpr(expr.high)
        }
        const dst = this.newReg()
        this.emit({ op: 'RANGE', dst, lo, hi, inc: expr.inclusive })
        return dst
      }
      case 'cast': {
        const src = this.genExpr(expr.expr)
        const dst = this.newReg()
        this.emit({ op: 'CAST', dst, to: expr.to, src })
        return dst
      }
      case 'if': {
        const dst = this.newReg()
        this._genIfInsts(expr, dst)
        return dst
      }
      case 'match': {
        const dst = this.newReg()
        this._genMatchInsts(expr, dst)
        return dst
      }
      case 'or': {
        // expr or { fallback } — 현재는 단순히 내부 expr만 컴파일
        return this.genExpr(expr.expr)
      }
      case 'anon_fn': {
        const anonName = `__anon_${this.newLabel('fn')}`
        const { insts: body } = this.withBuf(() => {
          for (const s of expr.body.stmts) this.genStmt(s)
        })
        this.fns.set(anonName, { name: anonName, params: expr.params.map(p => p.name), body })
        const dst = this.newReg()
        this.emit({ op: 'LOAD', dst, name: anonName })
        return dst
      }
      default: {
        // 미지원 expr: void 상수 반환
        const dst = this.newReg()
        this.emit({ op: 'CONST', dst, val: { v: 'void' } })
        return dst
      }
    }
  }

  // ─────────────────────────────────────────────────
  //  문장 컴파일
  // ─────────────────────────────────────────────────
  genStmt(stmt: A.Stmt): void {
    switch (stmt.t) {
      case 'expr_stmt':
        this.genExpr(stmt.expr)
        break

      case 'assign':
        this._genAssign(stmt)
        break

      case 'fn_decl':
        this._genFnDecl(stmt)
        break

      case 'struct_decl':
        this.structs.set(stmt.name, stmt)
        break

      case 'enum_decl':
        this.enums.set(stmt.name, stmt)
        break

      case 'const_decl': {
        const src = this.genExpr(stmt.value)
        this.emit({ op: 'STORE', name: stmt.name, src, decl: true, mut: false })
        break
      }

      case 'return': {
        const val = stmt.value ? this.genExpr(stmt.value) : null
        this.emit({ op: 'RET', val })
        break
      }

      case 'branch':
        this.emit({ op: stmt.kind === 'break' ? 'BREAK' : 'CONTINUE' })
        break

      case 'for': {
        if (stmt.cond) {
          // while 루프
          const { insts: condPfx, result: cond } = this.withBuf(() => this.genExpr(stmt.cond!))
          const { insts: body } = this.withBuf(() => {
            for (const s of stmt.body.stmts) this.genStmt(s)
          })
          this.emit({ op: 'WHILE', condPfx, cond, body })
        } else {
          // 무한 루프: cond = null
          const { insts: body } = this.withBuf(() => {
            for (const s of stmt.body.stmts) this.genStmt(s)
          })
          this.emit({ op: 'WHILE', condPfx: [], cond: null, body })
        }
        break
      }

      case 'for_c': {
        const { insts: init } = this.withBuf(() => {
          if (stmt.init) this.genStmt(stmt.init)
        })
        const { insts: condPfx, result: cond } = this.withBuf(() => {
          return stmt.cond ? this.genExpr(stmt.cond) : -1 as VReg
        })
        const { insts: post } = this.withBuf(() => {
          if (stmt.post) this.genStmt(stmt.post)
        })
        const { insts: body } = this.withBuf(() => {
          for (const s of stmt.body.stmts) this.genStmt(s)
        })
        const condReg = stmt.cond ? cond : -1
        this.emit({ op: 'FOR_C', init, condPfx, cond: condReg, post, body })
        break
      }

      case 'for_in': {
        const iter = this.genExpr(stmt.iterable)
        const { insts: body } = this.withBuf(() => {
          for (const s of stmt.body.stmts) this.genStmt(s)
        })
        this.emit({ op: 'FOR_IN', valVar: stmt.valVar, keyVar: stmt.keyVar, iter, body })
        break
      }

      case 'block': {
        const { insts: body } = this.withBuf(() => {
          for (const s of stmt.stmts) this.genStmt(s)
        })
        this.emit({ op: 'BLOCK', body })
        break
      }

      case 'defer': {
        const { insts: body } = this.withBuf(() => {
          for (const s of stmt.body.stmts) this.genStmt(s)
        })
        this.emit({ op: 'DEFER', body })
        break
      }

      case 'assert': {
        const cond = this.genExpr(stmt.cond)
        const msg = stmt.msg ? this.genExpr(stmt.msg) : null
        this.emit({ op: 'ASSERT', cond, msg })
        break
      }

      case 'label':
        this.emit({ op: 'LABEL', name: stmt.name })
        break

      case 'goto':
        this.emit({ op: 'JMP', label: stmt.label })
        break

      case 'type_decl':
      case 'interface_decl':
      case 'import':
      case 'module':
        break  // IR에서는 타입 선언/모듈 지시자 무시
    }
  }

  // ─────────────────────────────────────────────────
  //  내부 헬퍼
  // ─────────────────────────────────────────────────

  private _genFnDecl(fn: A.FnDecl): void {
    const { insts: body } = this.withBuf(() => {
      for (const s of fn.body.stmts) this.genStmt(s)
    })
    const name = fn.receiver ? `${fn.receiver.type}.${fn.name}` : fn.name
    // receiver가 있으면 첫 번째 파라미터로 추가
    const params = fn.receiver
      ? [fn.receiver.name, ...fn.params.map(p => p.name)]
      : fn.params.map(p => p.name)
    this.fns.set(name, { name, params, body })
  }

  private _genAssign(stmt: A.AssignStmt): void {
    const val = this.genExpr(stmt.value)
    const target = stmt.target

    if (target.t === 'ident') {
      if (stmt.op === ':=') {
        this.emit({ op: 'STORE', name: target.name, src: val, decl: true, mut: stmt.isMut })
      } else if (stmt.op === '=') {
        this.emit({ op: 'STORE', name: target.name, src: val, decl: false, mut: false })
      } else {
        // +=, -=, *=, /=, %=
        const cur = this.newReg()
        this.emit({ op: 'LOAD', dst: cur, name: target.name })
        const bop = stmt.op.slice(0, -1)
        const res = this.newReg()
        this.emit({ op: 'BINOP', dst: res, bop, l: cur, r: val })
        this.emit({ op: 'STORE', name: target.name, src: res, decl: false, mut: false })
      }
    } else if (target.t === 'index') {
      const obj = this.genExpr(target.obj)
      const idx = this.genExpr(target.index)
      if (stmt.op === '=') {
        this.emit({ op: 'SET_IDX', obj, idx, val })
      } else {
        const cur = this.newReg()
        this.emit({ op: 'GET_IDX', dst: cur, obj, idx })
        const res = this.newReg()
        this.emit({ op: 'BINOP', dst: res, bop: stmt.op.slice(0, -1), l: cur, r: val })
        this.emit({ op: 'SET_IDX', obj, idx, val: res })
      }
    } else if (target.t === 'selector') {
      const obj = this.genExpr(target.obj)
      if (stmt.op === '=') {
        this.emit({ op: 'SET_FLD', obj, fld: target.field, val })
      } else {
        const cur = this.newReg()
        this.emit({ op: 'GET_FLD', dst: cur, obj, fld: target.field })
        const res = this.newReg()
        this.emit({ op: 'BINOP', dst: res, bop: stmt.op.slice(0, -1), l: cur, r: val })
        this.emit({ op: 'SET_FLD', obj, fld: target.field, val: res })
      }
    }
  }

  private _genIfInsts(expr: A.IfExpr, dst: VReg): void {
    if (expr.branches.length === 0) return
    const resultVar = `__ifexpr_${dst}`
    // result 변수 초기화 (if 전에)
    const initR = this.newReg()
    this.emit({ op: 'CONST', dst: initR, val: { v: 'void' } })
    this.emit({ op: 'STORE', name: resultVar, src: initR, decl: true, mut: true })
    this._buildIfChain(expr.branches, 0, resultVar)
    // 결과 로드
    this.emit({ op: 'LOAD', dst, name: resultVar })
  }

  // 재귀적으로 if-else if-else 체인을 IF 명령어로 빌드
  // zig의 emitCondBr + emitLabel 패턴을 structured IR로 적용
  private _buildIfChain(branches: A.IfBranch[], idx: number, resultVar?: string): void {
    if (idx >= branches.length) return
    const br = branches[idx]

    const compileBody = (stmts: A.Stmt[]) => {
      for (let i = 0; i < stmts.length; i++) {
        const s = stmts[i]
        if (resultVar && i === stmts.length - 1 && s.t === 'expr_stmt') {
          // 마지막 표현식 → resultVar에 저장
          const r = this.genExpr(s.expr)
          this.emit({ op: 'STORE', name: resultVar, src: r, decl: false, mut: true })
        } else {
          this.genStmt(s)
        }
      }
    }

    if (!br.cond) {
      // else 브랜치: 조건 없이 body만 실행
      const { insts: body } = this.withBuf(() => {
        if (br.guard) {
          const gv = this.genExpr(br.guard.expr)
          this.emit({ op: 'STORE', name: br.guard.varName, src: gv, decl: true, mut: false })
        }
        compileBody(br.body.stmts)
      })
      this.emit({ op: 'BLOCK', body })
      return
    }

    // 조건 계산 (현재 버퍼에 emit, IF 명령어 앞에 위치)
    const cond = this.genExpr(br.cond)

    // then_ 컴파일
    const { insts: then_ } = this.withBuf(() => {
      if (br.guard) {
        const gv = this.genExpr(br.guard.expr)
        this.emit({ op: 'STORE', name: br.guard.varName, src: gv, decl: true, mut: false })
      }
      compileBody(br.body.stmts)
    })

    // else_ 체인 재귀 컴파일
    const { insts: else_ } = this.withBuf(() => {
      this._buildIfChain(branches, idx + 1, resultVar)
    })

    this.emit({ op: 'IF', cond, then_, else_ })
  }

  private _genMatchInsts(expr: A.MatchExpr, dst: VReg): void {
    const subj = this.genExpr(expr.subject)
    const arms: Array<{ pats: VReg[]; body: IRInst[] }> = []
    // match 표현식 결과를 담을 임시 변수
    const resultVar = `__match_${dst}`

    for (const arm of expr.arms) {
      const pats = arm.patterns.map(p => this.genExpr(p))
      const { insts: body } = this.withBuf(() => {
        // 마지막 stmt가 ExprStmt이면 그 결과를 result에 저장
        const stmts = arm.body.stmts
        for (let i = 0; i < stmts.length; i++) {
          const s = stmts[i]
          if (i === stmts.length - 1 && s.t === 'expr_stmt') {
            // 마지막 표현식 → 결과 캡처
            const r = this.genExpr(s.expr)
            this.emit({ op: 'STORE', name: resultVar, src: r, decl: false, mut: true })
          } else {
            this.genStmt(s)
          }
        }
      })
      arms.push({ pats, body })
    }

    // result 변수 초기화 (match 전에)
    const initR = this.newReg()
    this.emit({ op: 'CONST', dst: initR, val: { v: 'void' } })
    this.emit({ op: 'STORE', name: resultVar, src: initR, decl: true, mut: true })

    this.emit({ op: 'MATCH', subj, arms })

    // 결과 로드
    this.emit({ op: 'LOAD', dst, name: resultVar })
  }

  private _exprToKey(expr: A.Expr): string {
    if (expr.t === 'string' && expr.segments.length === 1 && expr.segments[0].kind === 'text') {
      return expr.segments[0].text
    }
    if (expr.t === 'ident') return expr.name
    if (expr.t === 'int') return expr.val.toString()
    return '?'
  }

  // V의 arr.map(expr_with_it) 지원 — expr가 'it' 식별자를 사용하는지 재귀 검사
  private _usesIdent(expr: A.Expr, name: string): boolean {
    if (!expr) return false
    if (expr.t === 'ident') return (expr as any).name === name
    // 재귀적으로 모든 하위 표현식 검사
    const checks = [
      (expr as any).left, (expr as any).right, (expr as any).expr,
      (expr as any).obj, (expr as any).callee, (expr as any).index,
    ]
    for (const c of checks) if (c && this._usesIdent(c, name)) return true
    for (const a of (expr as any).args ?? []) if (this._usesIdent(a, name)) return true
    for (const e of (expr as any).elems ?? []) if (this._usesIdent(e, name)) return true
    return false
  }

  // V의 arr.map(expr_with_it) → fn(it) { return expr } 람다 컴파일
  private _compileItLambda(body: A.Expr): VReg {
    // __anon_ 접두사로 등록 → LOAD 시 런타임 스코프를 클로저로 캡처
    const anonName = `__anon_it_${this._reg}`
    // 서브버퍼에서 람다 함수 바디 컴파일
    const { insts: lambdaBody, result: retReg } = this.withBuf(() => this.genExpr(body))
    lambdaBody.push({ op: 'RET', val: retReg })
    const fn: IRFn = { name: anonName, params: ['it'], body: lambdaBody }
    this.fns.set(anonName, fn)
    // LOAD 사용 → 런타임에 현재 스코프를 클로저로 캡처 (vm, scope 등 포함)
    const dst = this.newReg()
    this.emit({ op: 'LOAD', dst, name: anonName })
    return dst
  }
}

// ─────────────────────────────────────────────────────
//  IR 덤프: --ir 플래그로 사람이 읽기 쉬운 형식 출력
//  zig의 emit() + output ArrayList와 유사
// ─────────────────────────────────────────────────────
export function dumpIR(mod: IRModule): string {
  const lines: string[] = []

  lines.push(`; IR Module — ${mod.fns.size} functions, ${mod.structs.size} structs`)
  lines.push('')

  for (const [, fn] of mod.fns) {
    lines.push(`fn ${fn.name}(${fn.params.join(', ')}) {`)
    for (const inst of fn.body) {
      dumpInst(inst, lines, 1)
    }
    lines.push('}')
    lines.push('')
  }

  if (mod.main.length > 0) {
    lines.push('main {')
    for (const inst of mod.main) {
      dumpInst(inst, lines, 1)
    }
    lines.push('}')
  }

  return lines.join('\n')
}

function indent(depth: number): string { return '  '.repeat(depth) }

function dumpInst(inst: IRInst, out: string[], depth: number): void {
  const i = indent(depth)
  switch (inst.op) {
    case 'CONST':   out.push(`${i}%${inst.dst} = ${valStr(inst.val)}`); break
    case 'LOAD':    out.push(`${i}%${inst.dst} = load ${inst.name}`); break
    case 'STORE':   out.push(`${i}${inst.decl ? (inst.mut ? 'mut ' : 'let ') : ''}${inst.name} = %${inst.src}`); break
    case 'BINOP':   out.push(`${i}%${inst.dst} = %${inst.l} ${inst.bop} %${inst.r}`); break
    case 'UNOP':    out.push(`${i}%${inst.dst} = ${inst.uop}%${inst.src}`); break
    case 'ARRAY':   out.push(`${i}%${inst.dst} = [${inst.elems.map(r => `%${r}`).join(', ')}]`); break
    case 'MAP':     out.push(`${i}%${inst.dst} = {${inst.keys.map((k, j) => `${k}: %${inst.vals[j]}`).join(', ')}}`); break
    case 'STRUCT':  out.push(`${i}%${inst.dst} = ${inst.name}{${inst.fields.map(f => `${f.name}: %${f.src}`).join(', ')}}`); break
    case 'RANGE':   out.push(`${i}%${inst.dst} = %${inst.lo}..${inst.inc ? '=' : ''}%${inst.hi}`); break
    case 'GET_IDX': out.push(`${i}%${inst.dst} = %${inst.obj}[%${inst.idx}]`); break
    case 'SET_IDX': out.push(`${i}%${inst.obj}[%${inst.idx}] = %${inst.val}`); break
    case 'GET_FLD': out.push(`${i}%${inst.dst} = %${inst.obj}.${inst.fld}`); break
    case 'SET_FLD': out.push(`${i}%${inst.obj}.${inst.fld} = %${inst.val}`); break
    case 'CALL':    out.push(`${i}%${inst.dst} = call %${inst.callee}(${inst.args.map(r => `%${r}`).join(', ')})`); break
    case 'MCALL':   out.push(`${i}%${inst.dst} = %${inst.recv}.${inst.method}(${inst.args.map(r => `%${r}`).join(', ')})`); break
    case 'INTERP':  out.push(`${i}%${inst.dst} = interp(${inst.parts.map(p => p.kind === 'text' ? JSON.stringify(p.text) : `%${p.src}`).join('+')})`); break
    case 'CAST':    out.push(`${i}%${inst.dst} = ${inst.to}(%${inst.src})`); break
    case 'RET':     out.push(`${i}ret ${inst.val === null ? 'void' : `%${inst.val}`}`); break
    case 'BREAK':   out.push(`${i}break`); break
    case 'CONTINUE':out.push(`${i}continue`); break
    case 'LABEL':   out.push(`${inst.name}:`); break
    case 'JMP':     out.push(`${i}jmp ${inst.label}`); break
    case 'DEFER':   out.push(`${i}defer {`); inst.body.forEach(b => dumpInst(b, out, depth + 1)); out.push(`${i}}`); break
    case 'ASSERT':  out.push(`${i}assert %${inst.cond}${inst.msg !== null ? `, %${inst.msg}` : ''}`); break
    case 'POSTFIX': out.push(`${i}${inst.name}${inst.pop}`); break
    case 'IF':
      out.push(`${i}if %${inst.cond} {`)
      inst.then_.forEach(b => dumpInst(b, out, depth + 1))
      if (inst.else_.length > 0) {
        out.push(`${i}} else {`)
        inst.else_.forEach(b => dumpInst(b, out, depth + 1))
      }
      out.push(`${i}}`)
      break
    case 'WHILE':
      out.push(`${i}while${inst.cond === null ? ' (inf)' : ` %${inst.cond}`} {`)
      inst.body.forEach(b => dumpInst(b, out, depth + 1))
      out.push(`${i}}`)
      break
    case 'FOR_C':
      out.push(`${i}for_c (init; %${inst.cond}; post) {`)
      inst.body.forEach(b => dumpInst(b, out, depth + 1))
      out.push(`${i}}`)
      break
    case 'FOR_IN':
      out.push(`${i}for ${inst.keyVar ? `${inst.keyVar}, ` : ''}${inst.valVar} in %${inst.iter} {`)
      inst.body.forEach(b => dumpInst(b, out, depth + 1))
      out.push(`${i}}`)
      break
    case 'MATCH':
      out.push(`${i}match %${inst.subj} {`)
      for (const arm of inst.arms) {
        const pStr = arm.pats.length === 0 ? 'else' : arm.pats.map(r => `%${r}`).join(', ')
        out.push(`${i}  ${pStr} {`)
        arm.body.forEach(b => dumpInst(b, out, depth + 2))
        out.push(`${i}  }`)
      }
      out.push(`${i}}`)
      break
    case 'BLOCK':
      out.push(`${i}{`)
      inst.body.forEach(b => dumpInst(b, out, depth + 1))
      out.push(`${i}}`)
      break
  }
}

function valStr(v: IRVal): string {
  switch (v.v) {
    case 'int':    return v.n.toString()
    case 'float':  return v.f.toString()
    case 'bool':   return v.b.toString()
    case 'string': return JSON.stringify(v.s)
    case 'char':   return '`' + v.c + '`'
    case 'none':   return 'none'
    case 'void':   return 'void'
    default:       return `<${v.v}>`
  }
}
