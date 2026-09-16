// Source of out/tests/group/setup.test.luau (hand-written; only discovery reads it).
import { Assert, Test } from "@rbxts/lunit";
import { registry } from "../../shared/registry";

class SetupTests {
	@Test
	public registersTheFixture() {
		registry.register("fixture");
		Assert.equal(registry.names().size(), 1);
	}
}

export = SetupTests;
