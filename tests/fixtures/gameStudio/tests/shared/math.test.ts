// Source of out/tests/shared/math.test.luau: a test under tests/ importing
// from src/, the other source root.
import { Test } from "@rbxts/lunit";
import { add } from "../../src/shared/math";

class MathTests {
	@Test
	public addsNumbers() {
		assert(add(2, 3) === 5, "2 + 3 should be 5");
	}
}

export = MathTests;
