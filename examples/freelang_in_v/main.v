// FreeLang 인터프리터 메인 진입점 — V 언어로 구현
// 실행: npx tsx ../../src/main.ts main.v <script.fl>
//       (우리가 만든 V 컴파일러로 이 V 코드를 실행)
module main

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
