import * as ts from 'typescript';

export interface DiscoveredTest {
	methodName: string;
	displayName?: string;
	tags: string[];
	hasSkip: boolean;
	isOnly: boolean;
	eachCount?: number;
	line: number;
}

export interface DiscoveredClass {
	className: string;
	displayName?: string;
	tags: string[];
	line: number;
	tests: DiscoveredTest[];
}

function decoratorName(expr: ts.Expression): string | undefined {
	if (ts.isCallExpression(expr)) {
		return decoratorName(expr.expression);
	}
	if (ts.isIdentifier(expr)) {
		return expr.text;
	}
	if (ts.isPropertyAccessExpression(expr)) {
		return expr.name.text;
	}
	return undefined;
}

function decoratorArgs(expr: ts.Expression): readonly ts.Expression[] {
	return ts.isCallExpression(expr) ? expr.arguments : [];
}

function firstStringArg(args: readonly ts.Expression[]): string | undefined {
	const arg = args[0];
	return arg && ts.isStringLiteralLike(arg) ? arg.text : undefined;
}

function allStringArgs(args: readonly ts.Expression[]): string[] {
	return args.filter(ts.isStringLiteralLike).map((a) => a.text);
}

function getDecorators(node: ts.Node): readonly ts.Decorator[] {
	if (ts.canHaveDecorators(node)) {
		return ts.getDecorators(node) ?? [];
	}
	return [];
}

/**
 * Parses a Lunit test source file with the TypeScript compiler API and
 * returns every `@Test`-decorated method found on top-level classes, along
 * with the metadata attached via `@DisplayName`, `@Tag`, `@Skip`, `@Only`
 * and `@Each`.
 */
export function parseTestFile(filePath: string, sourceText: string): DiscoveredClass[] {
	const scriptKind = filePath.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
	const sourceFile = ts.createSourceFile(filePath, sourceText, ts.ScriptTarget.Latest, true, scriptKind);
	const classes: DiscoveredClass[] = [];

	sourceFile.forEachChild((statement) => {
		if (!ts.isClassDeclaration(statement) || !statement.name) {
			return;
		}

		const classDecorators = getDecorators(statement);
		let classDisplayName: string | undefined;
		const classTags: string[] = [];
		for (const dec of classDecorators) {
			const name = decoratorName(dec.expression);
			if (name === 'DisplayName') {
				classDisplayName = firstStringArg(decoratorArgs(dec.expression)) ?? classDisplayName;
			} else if (name === 'Tag') {
				classTags.push(...allStringArgs(decoratorArgs(dec.expression)));
			}
		}

		const discoveredClass: DiscoveredClass = {
			className: statement.name.text,
			displayName: classDisplayName,
			tags: classTags,
			line: sourceFile.getLineAndCharacterOfPosition(statement.getStart(sourceFile)).line,
			tests: [],
		};

		for (const member of statement.members) {
			if (!ts.isMethodDeclaration(member) || !member.name || !ts.isIdentifier(member.name)) {
				continue;
			}
			const memberDecorators = getDecorators(member);
			if (memberDecorators.length === 0) {
				continue;
			}

			let isTest = false;
			let displayName: string | undefined;
			const tags: string[] = [];
			let hasSkip = false;
			let isOnly = false;
			let eachCount: number | undefined;

			for (const dec of memberDecorators) {
				const name = decoratorName(dec.expression);
				const args = decoratorArgs(dec.expression);
				switch (name) {
					case 'Test':
						isTest = true;
						break;
					case 'DisplayName':
						displayName = firstStringArg(args) ?? displayName;
						break;
					case 'Tag':
						tags.push(...allStringArgs(args));
						break;
					case 'Skip':
						hasSkip = true;
						break;
					case 'Only':
						isOnly = true;
						break;
					case 'Each': {
						const arg = args[0];
						if (arg && ts.isArrayLiteralExpression(arg)) {
							eachCount = arg.elements.length;
						}
						break;
					}
					default:
						break;
				}
			}

			if (!isTest) {
				continue;
			}

			discoveredClass.tests.push({
				methodName: member.name.text,
				displayName,
				tags,
				hasSkip,
				isOnly,
				eachCount,
				line: sourceFile.getLineAndCharacterOfPosition(member.getStart(sourceFile)).line,
			});
		}

		if (discoveredClass.tests.length > 0) {
			classes.push(discoveredClass);
		}
	});

	return classes;
}
