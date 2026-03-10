// 배열과 맵 예제
module main

fn sum(arr []int) int {
	mut total := 0
	for x in arr {
		total += x
	}
	return total
}

fn filter_even(arr []int) []int {
	mut result := []int{}
	for x in arr {
		if x % 2 == 0 {
			result << x
		}
	}
	return result
}

fn main() {
	println('=== 배열 예제 ===')

	nums := [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
	println('배열: ${nums}')
	println('합계: ${sum(nums)}')

	evens := filter_even(nums)
	println('짝수: ${evens}')

	// 배열 인덱싱
	println('첫 번째: ${nums[0]}')
	println('마지막: ${nums[9]}')

	println('\n=== 맵 예제 ===')

	mut scores := {'alice': 95, 'bob': 87, 'charlie': 92}
	println('alice 점수: ${scores["alice"]}')
	scores['dave'] = 78
	println('dave 점수: ${scores["dave"]}')

	// 문자열 배열
	fruits := ['apple', 'banana', 'cherry', 'date']
	println('\n과일 목록:')
	for i, fruit in fruits {
		println('  ${i}: ${fruit}')
	}
}
