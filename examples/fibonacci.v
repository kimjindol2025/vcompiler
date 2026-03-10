// 피보나치 수열 (재귀 + 반복)
module main

fn fib_recursive(n int) int {
	if n <= 1 {
		return n
	}
	return fib_recursive(n - 1) + fib_recursive(n - 2)
}

fn fib_iterative(n int) int {
	if n <= 1 {
		return n
	}
	mut a := 0
	mut b := 1
	for i := 2; i <= n; i++ {
		c := a + b
		a = b
		b = c
	}
	return b
}

fn main() {
	println('=== 피보나치 수열 ===')

	// 재귀 방식
	println('재귀 방식:')
	for i := 0; i <= 10; i++ {
		print('fib(${i}) = ')
		println(fib_recursive(i))
	}

	// 반복 방식
	println('\n반복 방식:')
	for i := 0; i <= 15; i++ {
		print('fib(${i}) = ')
		println(fib_iterative(i))
	}
}
