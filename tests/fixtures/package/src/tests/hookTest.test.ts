// Source of out/tests/hookTest.test.luau (hand-written; only discovery reads it).
import { AfterEach, Tag, Test } from "@rbxts/lunit";

@Tag("Parallel")
class HookTestTests {
	@Test
	@AfterEach
	public both() {}

	@Test
	public plain() {}
}

export = HookTestTests;
