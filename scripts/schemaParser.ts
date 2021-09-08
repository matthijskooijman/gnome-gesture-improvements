import { readFileSync, writeFileSync } from 'fs';
import glob from 'glob';
import ts from 'typescript';
import parser from 'fast-xml-parser';

const SCHEMA_DIR = 'extension/schemas/';
const OUT_TSFILE = 'extension/generated/settings.ts';

const { SyntaxKind } = ts;

// import functions directly 
const {
	createArrayTypeNode,
	createBlock,
	createCallExpression,
	createEnumDeclaration,
	createEnumMember,
	createFunctionDeclaration,
	createFunctionTypeNode,
	createIdentifier,
	createImportClause,
	createImportDeclaration,
	createImportSpecifier,
	createInterfaceDeclaration,
	createKeywordTypeNode,
	createLiteralTypeNode,
	createMethodSignature,
	createModifier,
	createNamedImports,
	createNumericLiteral,
	createParameterDeclaration,
	createParenthesizedType,
	createPropertyAccessExpression,
	createQualifiedName,
	createReturnStatement,
	createSourceFile,
	createStringLiteral,
	createToken,
	createTypeAliasDeclaration,
	createTypeReferenceNode,
	createUnionTypeNode,
} = ts.factory;

//////////////////// Enum ///////////////////////

interface IEnumValue {
	'@_value': number,
	'@_nick': string,
}

interface IEnum {
	'@_id': string,
	'value': IEnumValue | IEnumValue[]
}

// returns enum declaration for enumObj
function CustomCreateEnumDeclaration(enumObj: IEnum): ts.EnumDeclaration {
	// name of enum, (aa.bb.c-c => c_c is name)
	let name = enumObj['@_id'].split('.').pop();
	if (name === undefined) {
		throw new Error(`name is empty for enum ${enumObj['@_id']}`);
	}
	name = name.toUpperCase().split(/[^\w]/).join('_');

	if (!(enumObj.value instanceof Array)) {
		enumObj.value = [enumObj.value];
	}

	const enumDeclaration = createEnumDeclaration(
		[],
		[createModifier(SyntaxKind.ExportKeyword)],
		name,
		enumObj.value.map(val => createEnumMember(val['@_nick'], createNumericLiteral(val['@_value']))),
	);

	return ts.addSyntheticLeadingComment(enumDeclaration, SyntaxKind.SingleLineCommentTrivia, ' enum declaration');
}

function generateEnumStatements(enumObjs: IEnum | IEnum[]): ts.Statement[] {
	if (enumObjs) {
		if (!(enumObjs instanceof Array)) {
			enumObjs = [enumObjs];
		}
		return enumObjs.map(CustomCreateEnumDeclaration);
	}
	return [];
}


//////////////////// Keys ///////////////////////

enum KeyType {
	Boolean = 'b',
	Integer = 'i',
	Double = 'd',
	String = 's',
	StringArray = 'as',
	EnumT = '@enum',
	OtherT = '@other',
}

interface IKey {
	'@_name': string,
	'@_type'?: KeyType,
	'@_enum'?: string,
}

interface IKeysByType {
	TypeName: string,
	ChangedTypeName: string,
	keys: IKey[],
	funtion_name: string,
	type?: ts.TypeNode,
}

function initializeKeyByTypeMap(): Map<KeyType, IKeysByType> {
	const keysByTypes = new Map<KeyType, IKeysByType>();
	keysByTypes.set(KeyType.Boolean, {
		TypeName: 'BooleanSettings',
		ChangedTypeName: 'ChangedBooleanSettings',
		keys: [],
		funtion_name: 'boolean',
		type: createKeywordTypeNode(SyntaxKind.BooleanKeyword),
	});
	keysByTypes.set(KeyType.Integer, {
		TypeName: 'IntegerSettings',
		ChangedTypeName: 'ChangedIntegerSettings',
		keys: [],
		funtion_name: 'int',
		type: createKeywordTypeNode(SyntaxKind.NumberKeyword),
	});
	keysByTypes.set(KeyType.Double, {
		TypeName: 'DoubleSettings',
		ChangedTypeName: 'ChangedDoubleSettings',
		keys: [],
		funtion_name: 'double',
		type: createKeywordTypeNode(SyntaxKind.NumberKeyword),
	});
	keysByTypes.set(KeyType.String, {
		TypeName: 'StringSettings',
		ChangedTypeName: 'ChangedStringSettings',
		keys: [],
		funtion_name: 'string',
		type: createKeywordTypeNode(SyntaxKind.StringKeyword),
	});
	keysByTypes.set(KeyType.StringArray, {
		TypeName: 'StringArraySettings',
		ChangedTypeName: 'ChangedStringArraySettings',
		keys: [],
		funtion_name: 'strv',
		type: createArrayTypeNode(createKeywordTypeNode(SyntaxKind.StringKeyword)),
	});
	keysByTypes.set(KeyType.EnumT, {
		TypeName: 'EnumSettings',
		ChangedTypeName: 'ChangedEnumSettings',
		keys: [],
		funtion_name: 'enum',
		type: createKeywordTypeNode(SyntaxKind.NumberKeyword),
	});

	keysByTypes.set(KeyType.OtherT, {
		TypeName: 'OtherSettings',
		ChangedTypeName: 'ChangedOtherSettings',
		keys: [],
		funtion_name: 'value',
		type: createTypeReferenceNode(createQualifiedName(createIdentifier('GLib'), 'Variant')),
	});

	return keysByTypes;
}

function CustomCreateTypeAliasDeclaration(name: string, type: ts.TypeNode) {
	return createTypeAliasDeclaration(
		[],
		[createModifier(ts.SyntaxKind.ExportKeyword), createModifier(SyntaxKind.DeclareKeyword)],
		name,
		[],
		type,
	);
}

function generatekeyTypeAliasesDeclaration(keyType: IKeysByType): ts.TypeAliasDeclaration[] {
	const keyNames = keyType.keys.map(k => k['@_name']);

	return [
		CustomCreateTypeAliasDeclaration(
			keyType.TypeName,
			createParenthesizedType(createUnionTypeNode(keyNames.map(k => createLiteralTypeNode(createStringLiteral(k))))),
		),
		CustomCreateTypeAliasDeclaration(
			keyType.ChangedTypeName,
			createParenthesizedType(createUnionTypeNode(keyNames.map(k => createLiteralTypeNode(createStringLiteral('changed::' + k))))),
		),
	];
}
declare interface ICustomParam {
	name: string,
	type?: ts.TypeNode,
}

function CustomCreateParameterDeclaration(param: ICustomParam): ts.ParameterDeclaration {
	return createParameterDeclaration([], [], undefined, param.name, undefined, param.type);
}

function CustomCreateMethodSignature(
	name: string,
	params: ICustomParam[],
	type?: ts.TypeNode,
): ts.MethodSignature {
	return createMethodSignature(
		[],
		name,
		undefined,
		[],
		params.map(CustomCreateParameterDeclaration),
		type,
	);
}

function createIExtensionSettingsInterface(keysByTypes: IKeysByType[]): ts.InterfaceDeclaration {
	const members: ts.TypeElement[] = [];

	// member for each type
	keysByTypes.forEach(keyType => {
		// get
		members.push(CustomCreateMethodSignature(
			`get_${keyType.funtion_name}`,
			[{
				name: 'key',
				type: createTypeReferenceNode(keyType.TypeName),
			}],
			keyType.type,
		));

		// set
		members.push(CustomCreateMethodSignature(
			`set_${keyType.funtion_name}`,
			[
				{
					name: 'key',
					type: createTypeReferenceNode(keyType.TypeName),
				},
				{
					name: 'value',
					type: keyType.type,
				},
			],
			createKeywordTypeNode(SyntaxKind.BooleanKeyword),
		));
	});

	// reset function
	members.push(CustomCreateMethodSignature(
		'reset',
		[
			{
				name: 'key',
				type: createTypeReferenceNode('AllTypeSettings'),
			},
		],
		createKeywordTypeNode(SyntaxKind.VoidKeyword),
	));

	// connect signal for changed
	members.push(CustomCreateMethodSignature(
		'connect',
		[
			{
				name: 'id',
				type: createUnionTypeNode([
					createLiteralTypeNode(createStringLiteral('changed')),
					createTypeReferenceNode('AllTypeChangedSettings'),
				]),
			},
			{
				name: 'callback',
				type: createFunctionTypeNode(
					[],
					[
						CustomCreateParameterDeclaration({
							name: '_settings',
							type: createTypeReferenceNode(createQualifiedName(createIdentifier('Gio'), 'Settings')),
						}),
						CustomCreateParameterDeclaration({
							name: 'key',
							type: createTypeReferenceNode('AllTypeSettings'),
						}),
					],
					createKeywordTypeNode(SyntaxKind.VoidKeyword),
				),
			},
		],
		createKeywordTypeNode(SyntaxKind.NumberKeyword),
	));

	// disconnect function
	members.push(CustomCreateMethodSignature(
		'disconnect',
		[
			{
				name: 'id',
				type: createKeywordTypeNode(SyntaxKind.NumberKeyword),
			},
		],
		createKeywordTypeNode(SyntaxKind.VoidKeyword),
	));

	// bind function
	members.push(CustomCreateMethodSignature(
		'bind',
		[
			{
				name: 'key',
				type: createTypeReferenceNode('AllTypeSettings'),
			},
			{
				name: 'object',
				type: createTypeReferenceNode(createQualifiedName(createIdentifier('GObject'), 'Object')),
			},
			{
				name: 'property',
				type: createKeywordTypeNode(SyntaxKind.StringKeyword),
			},
			{
				name: 'flags',
				type: createTypeReferenceNode(createQualifiedName(createIdentifier('Gio'), 'SettingsBindFlags')),
			},
		],
		createKeywordTypeNode(SyntaxKind.VoidKeyword),
	));

	return createInterfaceDeclaration(
		[],
		[createModifier(SyntaxKind.ExportKeyword), createModifier(SyntaxKind.DeclareKeyword)],
		'IExtensionSettings',
		[],
		[],
		members,
	);
}

function generateSettingsInterface(keys: IKey | IKey[]): ts.Statement[] {
	if (keys) {
		if (!(keys instanceof Array)) {
			keys = [keys];
		}
	}
	else {
		keys = [];
	}

	const statements: ts.Statement[] = [];
	const keysByTypes = initializeKeyByTypeMap();

	keys.forEach(key => {
		if (key['@_enum']) {
			keysByTypes.get(KeyType.EnumT)?.keys.push(key);
		}
		else if (key['@_type']) {
			const keyType = keysByTypes.get(key['@_type']);
			if (keyType === undefined) {
				keysByTypes.get(KeyType.OtherT)?.keys.push(key);
			}
			else {
				keyType.keys.push(key);
			}
		}
		else {
			throw new Error(`Key should have type or enum: ${key}`);
		}
	});

	const nonEmptykeyTypes: IKeysByType[] = [];
	// add type aliase for normal and 'changed::' key
	keysByTypes.forEach(value => {
		if (value.keys.length) {
			nonEmptykeyTypes.push(value);
			statements.push(...generatekeyTypeAliasesDeclaration(value));
		}
	});

	// generate combined types
	statements.push(CustomCreateTypeAliasDeclaration(
		'AllTypeSettings',
		createParenthesizedType(createUnionTypeNode(nonEmptykeyTypes.map(t => createTypeReferenceNode(t.TypeName)))),
	));
	statements.push(CustomCreateTypeAliasDeclaration(
		'AllTypeChangedSettings',
		createParenthesizedType(createUnionTypeNode(nonEmptykeyTypes.map(t => createTypeReferenceNode(t.ChangedTypeName)))),
	));

	// interface
	statements.push(createIExtensionSettingsInterface(nonEmptykeyTypes));
	return statements;
}

//////////////////// generator ///////////////////////

function generateGetSettingsFunction(): ts.FunctionDeclaration {
	return createFunctionDeclaration(
		[],
		[createModifier(SyntaxKind.ExportKeyword)],
		undefined,
		'getSettings',
		[],
		[],
		createTypeReferenceNode('IExtensionSettings'),
		createBlock([
			createReturnStatement(
				createCallExpression(
					createPropertyAccessExpression(
						createPropertyAccessExpression(
							createPropertyAccessExpression(
								createIdentifier('imports'),
								createIdentifier('misc'),
							),
							createIdentifier('extensionUtils'),
						),
						createIdentifier('getSettings'),
					),
					undefined,
					[],
				),
			),
		]),
	);
}


// returns statement for 'import <names> from moduleName'
function CustomCreateImportDeclaration(moduleName: string, names: string | string[]): ts.ImportDeclaration {
	let namespaceImport, namedImports;

	if (names instanceof Array) {
		namedImports = createNamedImports(
			names.map(name => createImportSpecifier(undefined, createIdentifier(name))),
		);
	}
	else {
		namespaceImport = createIdentifier(names);
	}

	return createImportDeclaration(
		[],
		[],
		createImportClause(
			false,
			namespaceImport,
			namedImports,
		),
		createStringLiteral(moduleName),
	);
}

function makeTsFile(enumObjs: IEnum | IEnum[], keys: IKey | IKey[]): ts.SourceFile {
	const statements: ts.Statement[] = [];
	
	// import 'imports' from gnome-shell
	// import 'Gio', 'GLib', 'GObject'
	statements.push(CustomCreateImportDeclaration('gnome-shell', ['imports']));
	statements.push(...['Gio', 'GLib', 'GObject'].map(lib => CustomCreateImportDeclaration(`@gi-types/${lib.toLowerCase()}`, lib)));

	// add top level comment
	ts.addSyntheticLeadingComment(
		statements[0],
		SyntaxKind.MultiLineCommentTrivia,
		'\nThis is generated file\n' +
		'Do not edit directly\n' +
		'Edit schema file instead and then run "npm run initialize"\n',
		true,
	);

	// enum statements
	statements.push(...generateEnumStatements(enumObjs));

	// settings interface
	statements.push(...generateSettingsInterface(keys));

	// add getSettings function
	statements.push(generateGetSettingsFunction());

	return createSourceFile(
		statements,
		createToken(SyntaxKind.EndOfFileToken),
		ts.NodeFlags.None,
	);
}

const matches = new glob.GlobSync(`${SCHEMA_DIR}/*.gschema.xml`);
matches.found.forEach(file => {
	const content = readFileSync(file).toString();
	const dom = parser.parse(
		content,
		{
			attributeNamePrefix: '@_',
			ignoreAttributes: false,
		},
	);
	const schemalist = dom['schemalist'];
	const schema = schemalist['schema'];
	const enumObjs = schemalist['enum'];
	const keys = schema['key'];
	console.log(`file: ${file}`);

	const printer = ts.createPrinter();
	const sourceFile = makeTsFile(enumObjs, keys);
	const result = printer.printFile(sourceFile);
	console.log(`result: \n${result}`);

	writeFileSync(OUT_TSFILE, result);
});