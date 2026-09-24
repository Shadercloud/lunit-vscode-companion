// Source of out/src/client/greeter.luau.
import { add } from "../shared/math";

export function greet(name: string, visits: number): string {
	return `Hello, ${name}! Visit #${add(visits, 1)}`;
}
