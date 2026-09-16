// Source of out/tests/ordered.test.luau (hand-written; only discovery reads it).
import { AfterAll, Assert, BeforeAll, Order, Test } from "@rbxts/lunit";

class OrderedTests {
	private log: string[] = [];

	@BeforeAll
	public setUpAll() {
		this.log.push("beforeAll");
	}

	@AfterAll
	public tearDownAll() {
		this.log.push("afterAll");
	}

	@Order(1)
	@Test
	public first() {
		Assert.equal(this.log.size(), 1, "BeforeAll must have run once before the first test");
		this.log.push("first");
	}

	@Order(2)
	@Test
	public second() {
		Assert.equal(this.log[1], "first", "second must run after first (@Order) in the same instance");
		this.log.push("second");
	}
}

export = OrderedTests;
