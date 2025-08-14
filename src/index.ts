#!/usr/bin/env node
import fs from "node:fs/promises";
import {
	type Entry,
	type Message,
	type PatternElement,
	type Placeable,
	type SelectExpression,
	type VariableReference,
	type FunctionReference,
	parse,
	type Expression,
} from "@fluent/syntax"
import { glob } from "glob"
import minimist from "minimist"
import prettier from "prettier"

const args = minimist(process.argv.slice(2));

const pattern = args._.at(0) ?? "**/*.ftl";

const paths = await glob(pattern);

function isMessage(x: Entry): x is Message {
	return x.type === "Message";
}

type ElementWithName = Placeable & {
	expression:
		| VariableReference
		| FunctionReference
		| (SelectExpression & { selector: VariableReference })
}

const EXPR_WITH_VAR_TYPES = new Set<Expression["type"]>([
	"SelectExpression",
	"VariableReference",
	"FunctionReference",
])
type ExprWithVarType =
	typeof EXPR_WITH_VAR_TYPES extends Set<infer R> ? R : never

function isExpressionWithVariable(
	x: Expression | PatternElement,
): x is Extract<Expression, { type: ExprWithVarType }> {
	if (x.type === "SelectExpression") {
		return isExpressionWithVariable(x.selector)
	}

	return EXPR_WITH_VAR_TYPES.has(x.type as ExprWithVarType)
}

function isPlaceable(x: PatternElement | Expression): x is ElementWithName {
	if (x.type === "Placeable") {
		return isExpressionWithVariable(x.expression)
	}

	return isExpressionWithVariable(x)
}

function extractEntryNames(
	element: Extract<PatternElement | Expression, { type: ExprWithVarType }>,
): string[] {
	if (element.type === "Placeable") {
		return extractEntryNames(element.expression)
	}

	if (element.type === "SelectExpression") {
		return extractEntryNames(element.selector)
	}

	if (element.type === "FunctionReference") {
		return element.arguments.positional
			.filter(isPlaceable)
			.flatMap(extractEntryNames)
	}

	if (element.type === "VariableReference") {
		return [element.id.name]
	}

	return []
}

async function processFile(path: string) {
	const file = String(await fs.readFile(path));

	const resource = parse(file, {});

	const generated: string[] = [
		"import type {",
		"	FluentBundle, ",
		"	FluentVariable, ",
		"	Message as FluentMessage ",
		"	// @ts-ignore",
		`} from "@fluent/bundle"`,
		"",
		"export interface LocalesMap {",
		...resource.body.filter(isMessage).map((entry) => {
			if (!entry.value?.elements.filter(isPlaceable).length)
			    return `"${entry.id.name}": never;`;

			const entryNames = new Set<string>(
				entry.value.elements
					.filter(isPlaceable)
					.flatMap(extractEntryNames),
			)

			const entryLines = Array
				.from(entryNames.values())
				.map((name) => `"${name}": FluentVariable;`)
				.join("\n")

			return `"${entry.id.name}": {
				${entryLines}
			};`
		}),
		"}",
		"",
		"export interface Message<Key extends keyof LocalesMap> extends FluentMessage {",
		"	id: Key;",
		"}",
		"",
		"export interface TypedFluentBundle extends FluentBundle {",
		"	getMessage<Key extends keyof LocalesMap>(key: Key): Message<Key>;",
		"	formatPattern<Key extends keyof LocalesMap>(key: Key, ...args: LocalesMap[Key] extends never ? [] : [args: LocalesMap[Key]]): string;",
		"	formatPattern<Key extends keyof LocalesMap>(key: Key, args: LocalesMap[Key] extends never ? null : LocalesMap[Key], errors?: Error[] | null): string;",
		"}",
	];

	fs.writeFile(
		args.o ?? args.output ?? "src/locales.types.ts",
		await prettier.format(generated.join("\n"), {
			tabWidth: 4,
			parser: "typescript",
			endOfLine: "auto",
			semi: false,
		}),
	);
}

for await (const path of paths) {
	await processFile(path);
	if (args.w || args.watch) {
		const events = fs.watch(path);

		for await (const event of events) {
			if (event.eventType !== "change") continue;
			await processFile(path);
		}
	}
}
