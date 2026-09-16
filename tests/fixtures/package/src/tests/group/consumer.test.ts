// Source of out/tests/group/consumer.test.luau (hand-written; only discovery reads it).
import { Assert, Test } from "@rbxts/lunit";
import { registry } from "../../shared/registry";

class ConsumerTests {
	@Test
	public seesTheFixture() {
		Assert.equal(registry.names()[0], "fixture", "setup.test must have run first in this VM");
	}
}

export = ConsumerTests;
