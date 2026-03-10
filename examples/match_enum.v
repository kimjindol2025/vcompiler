// match 표현식 + enum 예제
module main

enum Direction {
	north
	south
	east
	west
}

enum Color {
	red
	green
	blue
	yellow
}

fn direction_name(d Direction) string {
	return match d {
		.north { 'North (북)' }
		.south { 'South (남)' }
		.east  { 'East (동)' }
		.west  { 'West (서)' }
	}
}

fn classify_number(n int) string {
	return match true {
		n < 0   { '음수' }
		n == 0  { '영' }
		n < 10  { '한 자리 양수' }
		n < 100 { '두 자리 양수' }
		else    { '세 자리 이상 양수' }
	}
}

fn fizzbuzz(n int) string {
	return match 0 {
		n % 15 { 'FizzBuzz' }
		n % 3  { 'Fizz' }
		n % 5  { 'Buzz' }
		else   { '${n}' }
	}
}

fn main() {
	println('=== match / enum 예제 ===')

	dirs := [Direction.north, Direction.east, Direction.south, Direction.west]
	for d in dirs {
		println(direction_name(d))
	}

	println('\n수 분류:')
	test_nums := [-5, 0, 7, 42, 100, 999]
	for n in test_nums {
		println('  ${n} → ${classify_number(n)}')
	}

	println('\nFizzBuzz (1-20):')
	for i := 1; i <= 20; i++ {
		print(fizzbuzz(i))
		print(' ')
	}
	println('')
}
