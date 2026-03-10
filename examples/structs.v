// 구조체 + 메서드 예제
module main

struct Point {
mut:
	x f64
	y f64
}

fn (p Point) to_string() string {
	return 'Point(${p.x}, ${p.y})'
}

fn (p Point) distance_to(other Point) f64 {
	dx := p.x - other.x
	dy := p.y - other.y
	return (dx * dx + dy * dy)
}

struct Rectangle {
mut:
	top_left     Point
	bottom_right Point
}

fn (r Rectangle) area() f64 {
	w := r.bottom_right.x - r.top_left.x
	h := r.bottom_right.y - r.top_left.y
	return w * h
}

fn (r Rectangle) perimeter() f64 {
	w := r.bottom_right.x - r.top_left.x
	h := r.bottom_right.y - r.top_left.y
	return 2.0 * (w + h)
}

fn main() {
	println('=== 구조체 예제 ===')

	p1 := Point{ x: 0.0, y: 0.0 }
	p2 := Point{ x: 3.0, y: 4.0 }

	println(p1.to_string())
	println(p2.to_string())

	dist_sq := p1.distance_to(p2)
	println('거리^2: ${dist_sq}')

	rect := Rectangle{
		top_left:     Point{ x: 0.0, y: 0.0 }
		bottom_right: Point{ x: 5.0, y: 3.0 }
	}

	println('직사각형 넓이: ${rect.area()}')
	println('직사각형 둘레: ${rect.perimeter()}')
}
