// Source of out/tests/rows.test.luau (hand-written; only discovery reads it).
import { AfterEach, Assert, BeforeEach, Decorators, Tag, Test } from "@rbxts/lunit";
import { counter } from "../shared/counter";

const { Each } = Decorators;

@Tag("Parallel")
class RowTests {
	private ready = false;

	@BeforeEach
	public setUp() {
		this.ready = true;
		counter.bump();
	}

	@AfterEach
	public tearDown() {
		this.ready = false;
	}

	@Test
	public plain() {
		Assert.true(this.ready, "BeforeEach must have run for this case");
		Assert.equal(counter.value(), 1, "each case must start from a fresh module cache");
	}

	@Each([
		[1, 2, 3],
		[2, 2, 4],
		[2, 2, 5],
	])
	@Test
	public rows(a: number, b: number, expected: number) {
		Assert.true(this.ready, "BeforeEach must have run for this row");
		Assert.equal(counter.value(), 1, "each row must start from a fresh module cache");
		Assert.equal(a + b, expected, `${a} + ${b} should be ${expected}`);
	}

	@Tag("Slow")
	@Test
	public sweep() {
		Assert.true(this.ready);
	}
}

export = RowTests;
