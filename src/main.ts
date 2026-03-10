#!/usr/bin/env node
// V 언어 컴파일러 — CLI 진입점
// pipeline: source → Lexer → Parser → VM (tree-walking interpreter)

import { readFileSync } from 'fs'
import { Lexer }  from './lexer.js'
import { Parser } from './parser.js'
import { VM }     from './vm.js'
import { TK }     from './token.js'

// ────────────────────────────────────────────────────────────────
//  CLI 인자 처리
// ────────────────────────────────────────────────────────────────

const args = process.argv.slice(2)

function usage(): never {
  console.error(`
Usage:
  vcompiler <file.v>           파일 실행
  vcompiler --tokens <file.v>  토큰 목록 출력
  vcompiler --ast   <file.v>   AST 출력
  vcompiler --help             도움말
`)
  process.exit(1)
}

if (args.length === 0 || args[0] === '--help') usage()

// ────────────────────────────────────────────────────────────────
//  모드별 실행
// ────────────────────────────────────────────────────────────────

const flag = args[0].startsWith('--') ? args[0] : null
const file = flag ? args[1] : args[0]

if (!file) usage()

let source: string
try {
  source = readFileSync(file, 'utf8')
} catch (e: any) {
  console.error(`Error: cannot read file '${file}': ${e.message}`)
  process.exit(1)
}

// ─── 렉서 실행 ────────────────────────────────────────────────
const lexer  = new Lexer(source)
const tokens = lexer.scanAll()

if (flag === '--tokens') {
  // 토큰 덤프 모드
  for (const tok of tokens) {
    const kindStr = (TK as any)[tok.kind] ?? `TK(${tok.kind})`
    console.log(`[${tok.line}:${tok.col}] ${kindStr.padEnd(12)} ${JSON.stringify(tok.lit)}`)
  }
  process.exit(0)
}

// ─── 파서 실행 ────────────────────────────────────────────────
let vfile
try {
  const parser = new Parser(tokens)
  vfile = parser.parseFile()
} catch (e: any) {
  console.error(`Parse error: ${e.message}`)
  process.exit(1)
}

if (flag === '--ast') {
  // AST 덤프 모드
  console.log(JSON.stringify(vfile, (_k, v) =>
    // BigInt를 문자열로 직렬화
    typeof v === 'bigint' ? v.toString() + 'n' : v
  , 2))
  process.exit(0)
}

// ─── VM 실행 ──────────────────────────────────────────────────
try {
  const vm = new VM()
  vm.runFile(vfile)
} catch (e: any) {
  // RuntimeError는 이미 위치 정보 포함
  console.error(`Runtime error: ${e.message}`)
  if (process.env.VCOMPILER_DEBUG) console.error(e.stack)
  process.exit(1)
}
