// 클로저 + 고차 함수 예제
module main

fn make_adder(n int) fn(int) int {
	return fn(x int) int {
		return x + n
	}
}

fn make_counter() fn() int {
	mut count := 0
	return fn() int {
		count++
		return count
	}
}

fn apply(f fn(int) int, arr []int) []int {
	mut result := []int{}
	for x in arr {
		result << f(x)
	}
	return result
}

fn compose(f fn(int) int, g fn(int) int) fn(int) int {
	return fn(x int) int {
		return f(g(x))
	}
}

fn main() {
	println('=== 클로저 예제 ===')

	// make_adder
	add5  := make_adder(5)
	add10 := make_adder(10)
	println('add5(3)  = ${add5(3)}')
	println('add10(3) = ${add10(3)}')

	// make_counter
	counter := make_counter()
	println('\n카운터:')
	println(counter())
	println(counter())
	println(counter())

	// apply (map)
	nums := [1, 2, 3, 4, 5]
	doubled := apply(fn(x int) int { return x * 2 }, nums)
	println('\n두 배: ${doubled}')

	// compose
	double := fn(x int) int { return x * 2 }
	inc    := fn(x int) int { return x + 1 }
	double_then_inc := compose(inc, double)
	println('\ndouble_then_inc(5) = ${double_then_inc(5)}')
}
