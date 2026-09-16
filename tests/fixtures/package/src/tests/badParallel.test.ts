// Source of out/tests/badParallel.test.luau (hand-written; only discovery reads it).
import { BeforeAll, Order, Tag, Test } from "@rbxts/lunit";

@Tag("Parallel")
class BadParallelTests {
	@BeforeAll
	public setUpAll() {}

	@Order(1)
	@Test
	public first() {}

	@Test
	public second() {}
}

export = BadParallelTests;
