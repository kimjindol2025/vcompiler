// IR VM — IRModule 실행기
//
// zig-multi-backend에서 배운 구조:
//   - 레지스터 파일(regs[]):  각 VReg에 IRVal 저장
//   - 스코프 체인: 변수 선언/검색을 위한 환경
//   - 함수 프레임: 새 함수 호출마다 새 레지스터 파일 생성
//   - 신호(break/continue/return): Zig의 error union 대신 JS 예외로 구현
//
// pipeline: IRModule → IRExecutor.runModule() → stdout

import { IRModule, IRFn, IRInst, IRVal, VReg } from './ir.js'

// ─────────────────────────────────────────────────────
//  제어흐름 신호 (break, continue, return)
// ─────────────────────────────────────────────────────
class ReturnSignal  { constructor(public val: IRVal) {} }
class BreakSignal   {}
class ContinueSignal {}

// ─────────────────────────────────────────────────────
//  IRScope: 변수 환경 체인
// ─────────────────────────────────────────────────────
class IRScope {
  private vars = new Map<string, IRVal>()
  constructor(readonly parent?: IRScope) {}

  get(name: string): IRVal | undefined {
    return this.vars.has(name) ? this.vars.get(name) : this.parent?.get(name)
  }

  set(name: string, val: IRVal): void {
    if (this.vars.has(name)) {
      this.vars.set(name, val)
    } else if (this.parent?.has(name)) {
      this.parent.set(name, val)
    } else {
      this.vars.set(name, val)  // 글로벌 대입
    }
  }

  has(name: string): boolean {
    return this.vars.has(name) || (this.parent?.has(name) ?? false)
  }

  declare(name: string, val: IRVal): void {
    this.vars.set(name, val)
  }
}

// ─────────────────────────────────────────────────────
//  IRFrame: 함수 실행 프레임
//  zig의 current_frame_size와 유사한 개념
// ─────────────────────────────────────────────────────
class IRFrame {
  regs: IRVal[] = []    // 가상 레지스터 파일
  defers: IRInst[][] = []  // defer 스택

  constructor(public scope: IRScope) {}

  getReg(r: VReg): IRVal {
    return this.regs[r] ?? { v: 'void' }
  }

  setReg(r: VReg, val: IRVal): void {
    this.regs[r] = val
  }
}

// ─────────────────────────────────────────────────────
//  IRExecutor: IR 모듈 실행기
// ─────────────────────────────────────────────────────
export class IRExecutor {
  private mod!: IRModule
  private global!: IRScope

  // ─────────────────────────────────────────────────
  //  공개 진입점
  // ─────────────────────────────────────────────────
  runModule(mod: IRModule): void {
    this.mod = mod
    this.global = new IRScope()

    // 내장 함수 등록
    this._registerBuiltins()

    // struct/enum 타입 등록 (전역 scope에)
    for (const [name, decl] of mod.structs) {
      this.global.declare(name, { v: 'builtin', name: `struct:${name}` })
    }
    for (const [name, decl] of mod.enums) {
      this._registerEnum(name, decl)
    }

    // 함수 등록 (전역 scope에) — 익명함수는 제외 (closure 캡처 필요)
    for (const [name, fn] of mod.fns) {
      if (!name.startsWith('__anon_')) {
        this.global.declare(name, { v: 'fn', fn, closure: new Map() })
      }
    }

    // main() 실행: 먼저 최상위 문장, 그 다음 main() 호출
    const frame = new IRFrame(new IRScope(this.global))
    try {
      this._execInsts(mod.main, frame)
    } catch (e) {
      if (e instanceof ReturnSignal) { /* 최상위 return 무시 */ }
      else throw e
    }

    // main 함수가 있으면 호출
    const mainFn = mod.fns.get('main')
    if (mainFn) {
      this._callFn(mainFn, [], new Map())
    }
  }

  // ─────────────────────────────────────────────────
  //  명령어 실행 루프
  // ─────────────────────────────────────────────────
  private _execInsts(insts: IRInst[], frame: IRFrame): void {
    for (const inst of insts) {
      this._execOne(inst, frame)
    }
  }

  private _execOne(inst: IRInst, frame: IRFrame): void {
    switch (inst.op) {

      // ── 상수 ──────────────────────────────────────
      case 'CONST':
        frame.setReg(inst.dst, inst.val)
        break

      // ── 변수 ──────────────────────────────────────
      case 'LOAD': {
        const val = frame.scope.get(inst.name)
        if (val === undefined) {
          // 익명 함수 로드 (closure 캡처)
          if (inst.name.startsWith('__anon_')) {
            const fn = this.mod.fns.get(inst.name)
            if (fn) {
              const closure = this._captureScope(frame.scope)
              frame.setReg(inst.dst, { v: 'fn', fn, closure })
              break
            }
          }
          // __enum__.fieldname → enum 값 탐색
          if (inst.name.startsWith('__enum__.')) {
            const fieldName = inst.name.slice('__enum__.'.length)
            // 모든 enum에서 해당 필드 검색
            let found: IRVal | undefined
            for (const [, decl] of this.mod.enums) {
              const enumMap = this.global.get(decl.name)
              if (enumMap?.v === 'map') {
                const entry = enumMap.entries.get(fieldName)
                if (entry !== undefined) { found = entry; break }
              }
            }
            frame.setReg(inst.dst, found ?? { v: 'void' })
            break
          }
          // 일반 함수 또는 builtin
          const fn = this.mod.fns.get(inst.name)
          if (fn) {
            const closure = this._captureScope(frame.scope)
            frame.setReg(inst.dst, { v: 'fn', fn, closure })
          } else {
            const blt = this.global.get(inst.name)
            frame.setReg(inst.dst, blt ?? { v: 'void' })
          }
        } else {
          frame.setReg(inst.dst, val)
        }
        break
      }

      case 'STORE': {
        const val = frame.getReg(inst.src)
        if (inst.decl) {
          frame.scope.declare(inst.name, val)
        } else {
          frame.scope.set(inst.name, val)
        }
        break
      }

      // ── 이항 연산 (zig: emitAdd/emitICmp 등) ───────
      case 'BINOP': {
        const l = frame.getReg(inst.l)
        const r = frame.getReg(inst.r)
        frame.setReg(inst.dst, this._binop(inst.bop, l, r))
        break
      }

      // ── 단항 연산 ─────────────────────────────────
      case 'UNOP': {
        const src = frame.getReg(inst.src)
        frame.setReg(inst.dst, this._unop(inst.uop, src))
        break
      }

      // ── 컬렉션 생성 ───────────────────────────────
      case 'ARRAY': {
        const elems = inst.elems.map(r => frame.getReg(r))
        frame.setReg(inst.dst, { v: 'array', elems: [...elems] })
        break
      }

      case 'MAP': {
        const entries = new Map<string, IRVal>()
        inst.keys.forEach((k, i) => entries.set(k, frame.getReg(inst.vals[i])))
        frame.setReg(inst.dst, { v: 'map', entries })
        break
      }

      case 'STRUCT': {
        const fields = new Map<string, IRVal>()
        // 구조체 기본값 — 타입에 맞는 zero value 사용 (V 언어 규칙)
        const decl = this.mod.structs.get(inst.name)
        if (decl) {
          for (const f of decl.fields) {
            const t = f.type.replace(/^\[.*\]\s*/, '').replace(/^&/, '').replace(/\?$/, '')
            let def: IRVal
            if (t === 'string')                def = { v: 'string', s: '' }
            else if (t === 'int' || t === 'i64' || t === 'u64' || t === 'i32' || t === 'u32' || t === 'byte' || t === 'rune') def = { v: 'int', n: 0n }
            else if (t === 'f64' || t === 'f32' || t === 'float') def = { v: 'float', f: 0 }
            else if (t === 'bool')             def = { v: 'bool', b: false }
            else if (f.type.startsWith('['))   def = { v: 'array', elems: [] }
            else                               def = { v: 'void' }
            fields.set(f.name, def)
          }
        }
        for (const f of inst.fields) {
          fields.set(f.name, frame.getReg(f.src))
        }
        frame.setReg(inst.dst, { v: 'struct', name: inst.name, fields })
        break
      }

      case 'RANGE': {
        const lo = this._toNum(frame.getReg(inst.lo))
        const hi = this._toNum(frame.getReg(inst.hi))
        frame.setReg(inst.dst, { v: 'range', lo, hi, inc: inst.inc })
        break
      }

      // ── 인덱싱 ────────────────────────────────────
      case 'GET_IDX': {
        const obj = frame.getReg(inst.obj)
        const idx = frame.getReg(inst.idx)
        frame.setReg(inst.dst, this._getIdx(obj, idx))
        break
      }

      case 'SET_IDX': {
        const obj = frame.getReg(inst.obj)
        const idx = frame.getReg(inst.idx)
        const val = frame.getReg(inst.val)
        this._setIdx(obj, idx, val)
        break
      }

      // ── 필드 접근 ─────────────────────────────────
      case 'GET_FLD': {
        const obj = frame.getReg(inst.obj)
        frame.setReg(inst.dst, this._getField(obj, inst.fld))
        break
      }

      case 'SET_FLD': {
        const obj = frame.getReg(inst.obj)
        const val = frame.getReg(inst.val)
        this._setField(obj, inst.fld, val)
        break
      }

      // ── 함수 호출 (zig: emitCall) ──────────────────
      case 'CALL': {
        const callee = frame.getReg(inst.callee)
        const args = inst.args.map(r => frame.getReg(r))
        frame.setReg(inst.dst, this._callVal(callee, args, frame.scope))
        break
      }

      case 'MCALL': {
        const recv = frame.getReg(inst.recv)
        const args = inst.args.map(r => frame.getReg(r))
        frame.setReg(inst.dst, this._methodCall(recv, inst.method, args, frame.scope))
        break
      }

      // ── 문자열 보간 ───────────────────────────────
      case 'INTERP': {
        let s = ''
        for (const part of inst.parts) {
          if (part.kind === 'text') {
            s += part.text
          } else {
            s += this._valToStr(frame.getReg(part.src))
          }
        }
        frame.setReg(inst.dst, { v: 'string', s })
        break
      }

      // ── 타입 캐스트 ───────────────────────────────
      case 'CAST': {
        const src = frame.getReg(inst.src)
        frame.setReg(inst.dst, this._cast(inst.to, src))
        break
      }

      // ── 반환 ──────────────────────────────────────
      case 'RET': {
        const val = inst.val !== null ? frame.getReg(inst.val) : { v: 'void' as const }
        // defer 실행 (LIFO)
        this._runDefers(frame)
        throw new ReturnSignal(val)
      }

      // ── break / continue ──────────────────────────
      case 'BREAK':
        this._runDefers(frame)
        throw new BreakSignal()

      case 'CONTINUE':
        throw new ContinueSignal()

      // ── label / jmp (goto 지원) ────────────────────
      case 'LABEL':
      case 'JMP':
        // 플랫 IR에서는 goto가 드물어 단순 처리 (structured IR이므로)
        break

      // ── defer ──────────────────────────────────────
      case 'DEFER':
        frame.defers.push(inst.body)
        break

      // ── assert ─────────────────────────────────────
      case 'ASSERT': {
        const cond = frame.getReg(inst.cond)
        if (!this._isTruthy(cond)) {
          const msg = inst.msg !== null ? this._valToStr(frame.getReg(inst.msg)) : 'assertion failed'
          throw new Error(`AssertionError: ${msg}`)
        }
        break
      }

      // ── postfix x++, x-- ──────────────────────────
      case 'POSTFIX': {
        const cur = frame.scope.get(inst.name)
        if (cur && cur.v === 'int') {
          frame.scope.set(inst.name, { v: 'int', n: inst.pop === '++' ? cur.n + 1n : cur.n - 1n })
        } else if (cur && cur.v === 'float') {
          frame.scope.set(inst.name, { v: 'float', f: inst.pop === '++' ? cur.f + 1 : cur.f - 1 })
        }
        break
      }

      // ── 단락 평가 (short-circuit) ─────────────────
      case 'AND': {
        const lv = frame.getReg(inst.l)
        if (!this._isTruthy(lv)) {
          frame.setReg(inst.dst, { v: 'bool', b: false })
        } else {
          this._execInsts(inst.rPfx, frame)
          frame.setReg(inst.dst, { v: 'bool', b: this._isTruthy(frame.getReg(inst.r)) })
        }
        break
      }

      case 'OR': {
        const lv = frame.getReg(inst.l)
        if (this._isTruthy(lv)) {
          frame.setReg(inst.dst, { v: 'bool', b: true })
        } else {
          this._execInsts(inst.rPfx, frame)
          frame.setReg(inst.dst, { v: 'bool', b: this._isTruthy(frame.getReg(inst.r)) })
        }
        break
      }

      // ── 구조화 제어흐름 ───────────────────────────

      case 'IF': {
        const cond = frame.getReg(inst.cond)
        const branch = this._isTruthy(cond) ? inst.then_ : inst.else_
        const inner = new IRFrame(new IRScope(frame.scope))
        inner.defers = frame.defers
        this._execInsts(branch, inner)
        break
      }

      case 'WHILE': {
        // 루프 전 조건 재계산: condPfx를 매번 새 프레임에서 실행
        while (true) {
          // 조건 계산 프레임 (condPfx는 cond reg에 결과 저장)
          const condFrame = new IRFrame(new IRScope(frame.scope))
          condFrame.defers = frame.defers
          this._execInsts(inst.condPfx, condFrame)

          if (inst.cond !== null) {
            const cond = condFrame.getReg(inst.cond)
            if (!this._isTruthy(cond)) break
          }

          const inner = new IRFrame(new IRScope(frame.scope))
          inner.defers = frame.defers
          try {
            this._execInsts(inst.body, inner)
          } catch (e) {
            if (e instanceof BreakSignal) break
            if (e instanceof ContinueSignal) continue
            throw e
          }
        }
        break
      }

      case 'FOR_C': {
        // init
        const loopScope = new IRScope(frame.scope)
        const initFrame = new IRFrame(loopScope)
        initFrame.defers = frame.defers
        this._execInsts(inst.init, initFrame)

        while (true) {
          // cond
          const condFrame = new IRFrame(new IRScope(loopScope))
          condFrame.defers = frame.defers
          this._execInsts(inst.condPfx, condFrame)

          if (inst.cond >= 0) {
            const cond = condFrame.getReg(inst.cond)
            if (!this._isTruthy(cond)) break
          }

          // body
          const inner = new IRFrame(new IRScope(loopScope))
          inner.defers = frame.defers
          let shouldContinue = false
          try {
            this._execInsts(inst.body, inner)
          } catch (e) {
            if (e instanceof BreakSignal) break
            if (e instanceof ContinueSignal) { shouldContinue = true }
            else throw e
          }

          // post
          const postFrame = new IRFrame(loopScope)
          postFrame.defers = frame.defers
          this._execInsts(inst.post, postFrame)
        }
        break
      }

      case 'FOR_IN': {
        const iter = frame.getReg(inst.iter)
        const items = this._toIterable(iter)

        for (const [key, val] of items) {
          const inner = new IRFrame(new IRScope(frame.scope))
          inner.defers = frame.defers
          inner.scope.declare(inst.valVar, val)
          if (inst.keyVar) inner.scope.declare(inst.keyVar, { v: 'int', n: BigInt(key) })
          try {
            this._execInsts(inst.body, inner)
          } catch (e) {
            if (e instanceof BreakSignal) break
            if (e instanceof ContinueSignal) continue
            throw e
          }
        }
        break
      }

      case 'MATCH': {
        const subj = frame.getReg(inst.subj)
        for (const arm of inst.arms) {
          let matched = arm.pats.length === 0  // else arm
          if (!matched) {
            for (const patReg of arm.pats) {
              const pat = frame.getReg(patReg)
              if (this._eq(subj, pat)) { matched = true; break }
            }
          }
          if (matched) {
            const inner = new IRFrame(new IRScope(frame.scope))
            inner.defers = frame.defers
            try {
              this._execInsts(arm.body, inner)
            } catch (e) {
              if (e instanceof BreakSignal) break
              throw e
            }
            break
          }
        }
        break
      }

      case 'BLOCK': {
        const inner = new IRFrame(new IRScope(frame.scope))
        inner.defers = frame.defers
        this._execInsts(inst.body, inner)
        break
      }
    }
  }

  // ─────────────────────────────────────────────────
  //  함수 호출
  // ─────────────────────────────────────────────────
  private _callFn(fn: IRFn, args: IRVal[], closure: Map<string, IRVal>): IRVal {
    const scope = new IRScope(this.global)

    // closure 변수 복원
    for (const [k, v] of closure) scope.declare(k, v)

    // 파라미터 바인딩
    fn.params.forEach((p, i) => scope.declare(p, args[i] ?? { v: 'void' }))

    const frame = new IRFrame(scope)

    const syncClosure = () => {
      // 클로저 캡처 변수 뮤터블 업데이트: 함수 실행 후 변경된 값을 closure Map에 반영
      for (const k of closure.keys()) {
        const updated = scope.get(k)
        if (updated !== undefined) closure.set(k, updated)
      }
    }

    try {
      this._execInsts(fn.body, frame)
    } catch (e) {
      if (e instanceof ReturnSignal) {
        this._runDefers(frame)
        syncClosure()
        return e.val
      }
      throw e
    }

    this._runDefers(frame)
    syncClosure()
    return { v: 'void' }
  }

  private _callVal(callee: IRVal, args: IRVal[], scope: IRScope): IRVal {
    if (callee.v === 'fn') {
      return this._callFn(callee.fn, args, callee.closure)
    }
    if (callee.v === 'builtin') {
      return this._callBuiltin(callee.name, args, scope)
    }
    throw new Error(`호출 불가: ${JSON.stringify(callee)}`)
  }

  private _methodCall(recv: IRVal, method: string, args: IRVal[], scope: IRScope): IRVal {
    // 문자열 메서드
    if (recv.v === 'string') return this._strMethod(recv.s, method, args)
    if (recv.v === 'char')   return this._strMethod(recv.c, method, args)

    // 배열 메서드
    if (recv.v === 'array')  return this._arrMethod(recv.elems, method, args, scope)

    // 맵 메서드
    if (recv.v === 'map')    return this._mapMethod(recv.entries, method, args)

    // 구조체 메서드 (receiver를 첫 번째 인자로 전달)
    if (recv.v === 'struct') {
      const fnName = `${recv.name}.${method}`
      const fn = this.mod.fns.get(fnName)
      if (fn) {
        return this._callFn(fn, [recv, ...args], this._captureScope(scope))
      }
    }

    // .len 필드
    if (method === 'len') return this._getField(recv, 'len')

    throw new Error(`메서드 없음: ${recv.v}.${method}`)
  }

  // ─────────────────────────────────────────────────
  //  내장 함수
  // ─────────────────────────────────────────────────
  private _registerBuiltins(): void {
    const builtins = [
      'println', 'print', 'eprintln', 'eprint',
      'len', 'cap', 'sizeof', 'typeof', 'dump',
      'exit', 'panic', 'assert',
      'int', 'i64', 'u8', 'f32', 'f64', 'string', 'str', 'rune', 'byte',
      'bool',
    ]
    for (const name of builtins) {
      this.global.declare(name, { v: 'builtin', name })
    }
  }

  private _registerEnum(name: string, decl: any): void {
    let counter = 0
    for (const val of decl.values) {
      const n = val.value ? Number(val.value) : counter++
      const enumPath = `${name}.${val.name}`
      this.global.declare(enumPath, { v: 'int', n: BigInt(n) })
      // enum.Value 형태로도 등록
    }
    // enum 자체를 맵으로 등록
    const entries = new Map<string, IRVal>()
    counter = 0
    for (const val of decl.values) {
      const n = val.value ? Number(val.value) : counter++
      entries.set(val.name, { v: 'int', n: BigInt(n) })
    }
    this.global.declare(name, { v: 'map', entries })
  }

  private _callBuiltin(name: string, args: IRVal[], scope: IRScope): IRVal {
    switch (name) {
      case 'println': {
        const strs = args.map(a => this._valToStr(a))
        console.log(strs.join(' '))
        return { v: 'void' }
      }
      case 'print': {
        process.stdout.write(args.map(a => this._valToStr(a)).join(' '))
        return { v: 'void' }
      }
      case 'eprintln': {
        console.error(args.map(a => this._valToStr(a)).join(' '))
        return { v: 'void' }
      }
      case 'eprint': {
        process.stderr.write(args.map(a => this._valToStr(a)).join(' '))
        return { v: 'void' }
      }
      case 'len': {
        const a = args[0]
        if (!a) return { v: 'int', n: 0n }
        if (a.v === 'string') return { v: 'int', n: BigInt(a.s.length) }
        if (a.v === 'array')  return { v: 'int', n: BigInt(a.elems.length) }
        if (a.v === 'map')    return { v: 'int', n: BigInt(a.entries.size) }
        return { v: 'int', n: 0n }
      }
      case 'exit':
        process.exit(args[0]?.v === 'int' ? Number(args[0].n) : 0)
      case 'panic':
        throw new Error(`panic: ${args.map(a => this._valToStr(a)).join(' ')}`)
      // 타입 변환
      case 'int': case 'i64': case 'u8':
        return { v: 'int', n: this._toBigInt(args[0]) }
      case 'f32': case 'f64':
        return { v: 'float', f: this._toFloat(args[0]) }
      case 'string': case 'str':
        return { v: 'string', s: args[0] ? this._valToStr(args[0]) : '' }
      case 'bool':
        return { v: 'bool', b: args[0] ? this._isTruthy(args[0]) : false }
      case 'sizeof':
        return { v: 'int', n: 8n }
      case 'typeof':
        return { v: 'string', s: args[0]?.v ?? 'void' }
      case 'dump':
        console.error('[dump]', args.map(a => this._valToStr(a)).join(' '))
        return args[0] ?? { v: 'void' }
      default:
        return { v: 'void' }
    }
  }

  // ─────────────────────────────────────────────────
  //  연산자
  // ─────────────────────────────────────────────────
  private _binop(op: string, l: IRVal, r: IRVal): IRVal {
    // << 배열 append (V의 arr << elem 연산)
    if (op === '<<') {
      if (l.v === 'array') {
        if (r.v === 'array') l.elems.push(...r.elems)  // arr << arr2
        else                  l.elems.push(r)            // arr << elem
        return l
      }
    }

    // 문자열 연산
    if (l.v === 'string' || r.v === 'string') {
      const ls = this._valToStr(l), rs = this._valToStr(r)
      if (op === '+') return { v: 'string', s: ls + rs }
      if (op === '==') return { v: 'bool', b: ls === rs }
      if (op === '!=') return { v: 'bool', b: ls !== rs }
      if (op === '<')  return { v: 'bool', b: ls < rs }
      if (op === '>')  return { v: 'bool', b: ls > rs }
      if (op === '<=') return { v: 'bool', b: ls <= rs }
      if (op === '>=') return { v: 'bool', b: ls >= rs }
    }

    // 논리 연산
    if (op === '&&') return { v: 'bool', b: this._isTruthy(l) && this._isTruthy(r) }
    if (op === '||') return { v: 'bool', b: this._isTruthy(l) || this._isTruthy(r) }

    // in 연산자
    if (op === 'in') {
      if (r.v === 'array') return { v: 'bool', b: r.elems.some(e => this._eq(e, l)) }
      if (r.v === 'map')   return { v: 'bool', b: r.entries.has(this._valToStr(l)) }
      if (r.v === 'string' && l.v === 'string') return { v: 'bool', b: r.s.includes(l.s) }
      if (r.v === 'range') {
        const n = this._toNum(l)
        const hi = r.inc ? r.hi : r.hi - 1
        return { v: 'bool', b: n >= r.lo && n <= hi }
      }
      return { v: 'bool', b: false }
    }

    // 정수 연산 (zig: emitAdd/emitSub/emitMul/emitSdiv/emitSrem/emitICmp)
    if (l.v === 'int' && r.v === 'int') {
      const a = l.n, b = r.n
      switch (op) {
        case '+':  return { v: 'int', n: a + b }
        case '-':  return { v: 'int', n: a - b }
        case '*':  return { v: 'int', n: a * b }
        case '/':  return { v: 'int', n: b !== 0n ? a / b : 0n }
        case '%':  return { v: 'int', n: b !== 0n ? a % b : 0n }
        case '&':  return { v: 'int', n: a & b }
        case '|':  return { v: 'int', n: a | b }
        case '^':  return { v: 'int', n: a ^ b }
        case '<<': return { v: 'int', n: a << b }
        case '>>': return { v: 'int', n: a >> b }
        case '==': return { v: 'bool', b: a === b }
        case '!=': return { v: 'bool', b: a !== b }
        case '<':  return { v: 'bool', b: a < b }
        case '>':  return { v: 'bool', b: a > b }
        case '<=': return { v: 'bool', b: a <= b }
        case '>=': return { v: 'bool', b: a >= b }
      }
    }

    // 실수 연산
    if (l.v === 'float' || r.v === 'float') {
      const a = l.v === 'float' ? l.f : Number((l as any).n)
      const b = r.v === 'float' ? r.f : Number((r as any).n)
      switch (op) {
        case '+':  return { v: 'float', f: a + b }
        case '-':  return { v: 'float', f: a - b }
        case '*':  return { v: 'float', f: a * b }
        case '/':  return { v: 'float', f: a / b }
        case '%':  return { v: 'float', f: a % b }
        case '==': return { v: 'bool', b: a === b }
        case '!=': return { v: 'bool', b: a !== b }
        case '<':  return { v: 'bool', b: a < b }
        case '>':  return { v: 'bool', b: a > b }
        case '<=': return { v: 'bool', b: a <= b }
        case '>=': return { v: 'bool', b: a >= b }
      }
    }

    // bool 연산
    if (l.v === 'bool' && r.v === 'bool') {
      if (op === '==') return { v: 'bool', b: l.b === r.b }
      if (op === '!=') return { v: 'bool', b: l.b !== r.b }
    }

    // 일반 동등 비교 (struct/none/void 등 타입 혼합)
    if (op === '==') return { v: 'bool', b: this._eq(l, r) }
    if (op === '!=') return { v: 'bool', b: !this._eq(l, r) }

    return { v: 'void' }
  }

  private _unop(op: string, src: IRVal): IRVal {
    switch (op) {
      case '-':
        if (src.v === 'int')   return { v: 'int', n: -src.n }
        if (src.v === 'float') return { v: 'float', f: -src.f }
        break
      case '!':
        return { v: 'bool', b: !this._isTruthy(src) }
      case '~':
        if (src.v === 'int') return { v: 'int', n: ~src.n }
        break
      case '&':
        return src  // 주소 연산자 — 값 그대로 반환
      case '*':
        return src  // 역참조 — 값 그대로 반환
      case 'is_none':
        return { v: 'bool', b: src.v === 'none' || src.v === 'void' }
      case 'unwrap':
        return src.v === 'none' ? { v: 'void' } : src
      case 'copy':
        return src
    }
    return { v: 'void' }
  }

  // ─────────────────────────────────────────────────
  //  인덱싱 / 필드 접근
  // ─────────────────────────────────────────────────
  private _getIdx(obj: IRVal, idx: IRVal): IRVal {
    // range 슬라이싱: s[a..b], arr[a..b]
    if (idx.v === 'range') {
      const lo = idx.lo
      // hi = -1 은 open-ended (s[5..]) → end of string/array
      const rawHi = idx.hi
      const hi = rawHi === -1
        ? undefined  // slice(lo) = to end
        : (idx.inc ? rawHi + 1 : rawHi)
      if (obj.v === 'string') return { v: 'string', s: obj.s.slice(lo, hi) }
      if (obj.v === 'array')  return { v: 'array', elems: obj.elems.slice(lo, hi) }
      return { v: 'void' }
    }
    if (obj.v === 'array') {
      const i = this._toNum(idx)
      return obj.elems[i < 0 ? obj.elems.length + i : i] ?? { v: 'void' }
    }
    if (obj.v === 'map') {
      return obj.entries.get(this._valToStr(idx)) ?? { v: 'none' }
    }
    if (obj.v === 'string') {
      const i = this._toNum(idx)
      const ch = obj.s[i < 0 ? obj.s.length + i : i]
      return ch !== undefined ? { v: 'char', c: ch } : { v: 'void' }
    }
    return { v: 'void' }
  }

  private _setIdx(obj: IRVal, idx: IRVal, val: IRVal): void {
    if (obj.v === 'array') {
      const i = this._toNum(idx)
      obj.elems[i < 0 ? obj.elems.length + i : i] = val
    } else if (obj.v === 'map') {
      obj.entries.set(this._valToStr(idx), val)
    }
  }

  private _getField(obj: IRVal, fld: string): IRVal {
    // .len 공통 속성
    if (fld === 'len') {
      if (obj.v === 'string') return { v: 'int', n: BigInt(obj.s.length) }
      if (obj.v === 'array')  return { v: 'int', n: BigInt(obj.elems.length) }
      if (obj.v === 'map')    return { v: 'int', n: BigInt(obj.entries.size) }
      if (obj.v === 'range')  return { v: 'int', n: BigInt(obj.inc ? obj.hi - obj.lo + 1 : obj.hi - obj.lo) }
    }

    if (obj.v === 'struct') {
      return obj.fields.get(fld) ?? { v: 'void' }
    }
    if (obj.v === 'map') {
      return obj.entries.get(fld) ?? { v: 'none' }
    }

    return { v: 'void' }
  }

  private _setField(obj: IRVal, fld: string, val: IRVal): void {
    if (obj.v === 'struct') {
      obj.fields.set(fld, val)
    } else if (obj.v === 'map') {
      obj.entries.set(fld, val)
    }
  }

  // ─────────────────────────────────────────────────
  //  문자열 메서드
  // ─────────────────────────────────────────────────
  private _strMethod(s: string, method: string, args: IRVal[]): IRVal {
    switch (method) {
      case 'len':         return { v: 'int', n: BigInt(s.length) }
      case 'str':         return { v: 'string', s }
      case 'to_upper':    return { v: 'string', s: s.toUpperCase() }
      case 'to_lower':    return { v: 'string', s: s.toLowerCase() }
      case 'trim_space':  return { v: 'string', s: s.trim() }
      case 'trim':        return { v: 'string', s: s.trim() }
      case 'contains':    return { v: 'bool', b: s.includes(this._valToStr(args[0])) }
      case 'starts_with': return { v: 'bool', b: s.startsWith(this._valToStr(args[0])) }
      case 'ends_with':   return { v: 'bool', b: s.endsWith(this._valToStr(args[0])) }
      case 'replace': {
        const from = this._valToStr(args[0])
        const to   = this._valToStr(args[1] ?? { v: 'string', s: '' })
        return { v: 'string', s: s.split(from).join(to) }
      }
      case 'split': {
        const delim = this._valToStr(args[0] ?? { v: 'string', s: '' })
        return { v: 'array', elems: (delim === '' ? [...s] : s.split(delim)).map(c => ({ v: 'string', s: c })) }
      }
      case 'split_lines':
        return { v: 'array', elems: s.split(/\r?\n/).map(l => ({ v: 'string', s: l })) }
      case 'index': {
        const sub = this._valToStr(args[0])
        return { v: 'int', n: BigInt(s.indexOf(sub)) }
      }
      case 'substr': case 'slice': {
        const from = this._toNum(args[0])
        const to   = args[1] ? this._toNum(args[1]) : s.length
        return { v: 'string', s: s.slice(from, to) }
      }
      case 'int': return { v: 'int', n: BigInt(parseInt(s, 10) || 0) }
      case 'f64': return { v: 'float', f: parseFloat(s) || 0 }
      case 'bytes': return { v: 'array', elems: [...s].map(c => ({ v: 'int' as const, n: BigInt(c.charCodeAt(0)) })) }
      case 'runes': return { v: 'array', elems: [...s].map(c => ({ v: 'char' as const, c })) }
      case 'repeat': return { v: 'string', s: s.repeat(this._toNum(args[0])) }
    }
    return { v: 'void' }
  }

  // ─────────────────────────────────────────────────
  //  배열 메서드
  // ─────────────────────────────────────────────────
  private _arrMethod(elems: IRVal[], method: string, args: IRVal[], scope: IRScope): IRVal {
    switch (method) {
      case 'len':    return { v: 'int', n: BigInt(elems.length) }
      case 'push': case 'append':
        elems.push(...args)
        return { v: 'void' }
      case 'pop':    return elems.pop() ?? { v: 'void' }
      case 'first':  return elems[0] ?? { v: 'none' }
      case 'last':   return elems[elems.length - 1] ?? { v: 'none' }
      case 'join':   return { v: 'string', s: elems.map(e => this._valToStr(e)).join(this._valToStr(args[0] ?? { v: 'string', s: '' })) }
      case 'contains': return { v: 'bool', b: elems.some(e => this._eq(e, args[0])) }
      case 'index': {
        const idx = elems.findIndex(e => this._eq(e, args[0]))
        return { v: 'int', n: BigInt(idx) }
      }
      case 'reverse': {
        const rev = [...elems].reverse()
        return { v: 'array', elems: rev }
      }
      case 'sort': {
        const sorted = [...elems].sort((a, b) => {
          const av = a.v === 'int' ? Number(a.n) : a.v === 'float' ? a.f : this._valToStr(a)
          const bv = b.v === 'int' ? Number(b.n) : b.v === 'float' ? b.f : this._valToStr(b)
          return av < bv ? -1 : av > bv ? 1 : 0
        })
        return { v: 'array', elems: sorted }
      }
      case 'filter': {
        if (args[0]?.v === 'fn') {
          const filtered = elems.filter(e => {
            const r = this._callFn((args[0] as any).fn, [e], (args[0] as any).closure)
            return this._isTruthy(r)
          })
          return { v: 'array', elems: filtered }
        }
        return { v: 'array', elems }
      }
      case 'map': {
        if (args[0]?.v === 'fn') {
          const mapped = elems.map(e => this._callFn((args[0] as any).fn, [e], (args[0] as any).closure))
          return { v: 'array', elems: mapped }
        }
        return { v: 'array', elems }
      }
      case 'any': return { v: 'bool', b: elems.some(e => this._isTruthy(this._callVal(args[0], [e], scope))) }
      case 'all': return { v: 'bool', b: elems.every(e => this._isTruthy(this._callVal(args[0], [e], scope))) }
      case 'slice': {
        const from = args[0] ? this._toNum(args[0]) : 0
        const to   = args[1] ? this._toNum(args[1]) : elems.length
        return { v: 'array', elems: elems.slice(from, to) }
      }
      case 'delete': {
        elems.splice(this._toNum(args[0]), 1)
        return { v: 'void' }
      }
    }
    return { v: 'void' }
  }

  // ─────────────────────────────────────────────────
  //  맵 메서드
  // ─────────────────────────────────────────────────
  private _mapMethod(entries: Map<string, IRVal>, method: string, args: IRVal[]): IRVal {
    switch (method) {
      case 'len':    return { v: 'int', n: BigInt(entries.size) }
      case 'keys':   return { v: 'array', elems: [...entries.keys()].map(k => ({ v: 'string', s: k })) }
      case 'values': return { v: 'array', elems: [...entries.values()] }
      case 'has': case 'contains':
        return { v: 'bool', b: entries.has(this._valToStr(args[0])) }
      case 'delete':
        entries.delete(this._valToStr(args[0]))
        return { v: 'void' }
    }
    return { v: 'void' }
  }

  // ─────────────────────────────────────────────────
  //  for-in 이터러블 변환
  // ─────────────────────────────────────────────────
  private _toIterable(val: IRVal): Array<[number, IRVal]> {
    if (val.v === 'array') {
      return val.elems.map((e, i) => [i, e])
    }
    if (val.v === 'range') {
      const result: Array<[number, IRVal]> = []
      const hi = val.inc ? val.hi + 1 : val.hi
      for (let i = val.lo; i < hi; i++) {
        result.push([i - val.lo, { v: 'int', n: BigInt(i) }])
      }
      return result
    }
    if (val.v === 'string') {
      return [...val.s].map((c, i) => [i, { v: 'char', c }])
    }
    if (val.v === 'map') {
      let i = 0
      const result: Array<[number, IRVal]> = []
      for (const [k, v] of val.entries) {
        result.push([i++, v])
      }
      return result
    }
    return []
  }

  // ─────────────────────────────────────────────────
  //  타입 변환 헬퍼
  // ─────────────────────────────────────────────────
  private _cast(to: string, src: IRVal): IRVal {
    switch (to) {
      case 'int': case 'i32': case 'i64': case 'u8': case 'u32': case 'u64':
        return { v: 'int', n: this._toBigInt(src) }
      case 'f32': case 'f64':
        return { v: 'float', f: this._toFloat(src) }
      case 'string': case 'str':
        return { v: 'string', s: this._valToStr(src) }
      case 'bool':
        return { v: 'bool', b: this._isTruthy(src) }
      case 'byte': case 'rune':
        if (src.v === 'char')   return { v: 'int', n: BigInt(src.c.charCodeAt(0)) }
        if (src.v === 'string') return { v: 'int', n: BigInt(src.s.charCodeAt(0)) }
        return { v: 'int', n: this._toBigInt(src) }
    }
    return src
  }

  private _isTruthy(v: IRVal): boolean {
    if (v.v === 'bool')   return v.b
    if (v.v === 'int')    return v.n !== 0n
    if (v.v === 'float')  return v.f !== 0
    if (v.v === 'string') return v.s !== ''
    if (v.v === 'none')   return false
    if (v.v === 'void')   return false
    return true
  }

  private _eq(a: IRVal, b: IRVal): boolean {
    if (a.v !== b.v) return false
    if (a.v === 'int'    && b.v === 'int')    return a.n === b.n
    if (a.v === 'float'  && b.v === 'float')  return a.f === b.f
    if (a.v === 'bool'   && b.v === 'bool')   return a.b === b.b
    if (a.v === 'string' && b.v === 'string') return a.s === b.s
    if (a.v === 'char'   && b.v === 'char')   return a.c === b.c
    if (a.v === 'none')   return true
    if (a.v === 'void')   return true   // void == void (nil == nil)
    return false
  }

  private _toNum(v: IRVal): number {
    if (v.v === 'int')   return Number(v.n)
    if (v.v === 'float') return Math.floor(v.f)
    return 0
  }

  private _toBigInt(v: IRVal): bigint {
    if (v.v === 'int')    return v.n
    if (v.v === 'float')  return BigInt(Math.floor(v.f))
    if (v.v === 'string') return BigInt(parseInt(v.s, 10) || 0)
    if (v.v === 'bool')   return v.b ? 1n : 0n
    return 0n
  }

  private _toFloat(v: IRVal): number {
    if (v.v === 'float') return v.f
    if (v.v === 'int')   return Number(v.n)
    if (v.v === 'string') return parseFloat(v.s) || 0
    return 0
  }

  private _valToStr(v: IRVal): string {
    if (v.v === 'string') return v.s
    if (v.v === 'char')   return v.c
    if (v.v === 'int')    return v.n.toString()
    if (v.v === 'float')  return v.f.toString()
    if (v.v === 'bool')   return v.b.toString()
    if (v.v === 'none')   return 'none'
    if (v.v === 'void')   return ''
    if (v.v === 'array')  return '[' + v.elems.map(e => this._valToStr(e)).join(', ') + ']'
    if (v.v === 'map') {
      const pairs = [...v.entries].map(([k, val]) => `'${k}': ${this._valToStr(val)}`)
      return '{' + pairs.join(', ') + '}'
    }
    if (v.v === 'struct') {
      const fields = [...v.fields].map(([k, val]) => `${k}: ${this._valToStr(val)}`)
      return `${v.name}{${fields.join(', ')}}`
    }
    if (v.v === 'fn')      return `fn(${v.fn.params.join(', ')})`
    if (v.v === 'builtin') return `<builtin:${v.name}>`
    if (v.v === 'range')   return `${v.lo}..${v.inc ? '=' : ''}${v.hi}`
    return ''
  }

  private _captureScope(scope: IRScope): Map<string, IRVal> {
    // 현재 스코프 체인의 모든 변수를 캡처 (closure 지원)
    // zig-multi-backend의 alloca+store 클로저와 동일한 효과
    const captured = new Map<string, IRVal>()
    let cur: IRScope | undefined = scope
    while (cur) {
      // IRScope의 private vars에 직접 접근하기 위한 타입 단언
      const vars = (cur as any).vars as Map<string, IRVal>
      for (const [k, v] of vars) {
        if (!captured.has(k)) captured.set(k, v)
      }
      cur = cur.parent
    }
    return captured
  }

  private _runDefers(frame: IRFrame): void {
    // defer 스택을 LIFO 순서로 실행
    while (frame.defers.length > 0) {
      const body = frame.defers.pop()!
      const inner = new IRFrame(new IRScope(frame.scope))
      try {
        this._execInsts(body, inner)
      } catch (_e) { /* defer 중 예외는 무시 */ }
    }
  }
}
