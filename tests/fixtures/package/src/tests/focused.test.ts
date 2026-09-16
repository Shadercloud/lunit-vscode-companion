// Source of out/tests/focused.test.luau (hand-written; only discovery reads it).
import { Decorators, Tag, Test } from "@rbxts/lunit";

const { Only } = Decorators;

@Tag("Parallel")
class FocusedTests {
	@Only
	@Test
	public focused() {}

	@Test
	public shadowed() {
		error("a test shadowed by @Only must not run");
	}
}

export = FocusedTests;
