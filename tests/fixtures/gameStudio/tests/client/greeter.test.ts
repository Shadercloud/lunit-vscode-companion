// Source of out/tests/client/greeter.test.luau.
import { Test } from "@rbxts/lunit";
import { greet } from "../../src/client/greeter";

class GreeterTests {
	@Test
	public greetsByName() {
		assert(greet("Ada", 1) === "Hello, Ada! Visit #2", "greeting");
	}
}

export = GreeterTests;
