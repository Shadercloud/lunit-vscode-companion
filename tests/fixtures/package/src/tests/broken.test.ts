// Source of out/tests/broken.test.luau (hand-written; only discovery reads it).
// The compiled module errors at load, so this test can never report a result.
import { Test } from "@rbxts/lunit";

class BrokenTests {
	@Test
	public anything() {}
}

export = BrokenTests;
