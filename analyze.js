const controller = require("./_controller");
const escodegen = require("escodegen");
const esprima = require("esprima");
const fs = require("fs");
const path = require("path");
const {VM} = require("vm2");

const filename = process.argv[2];

const commandLineArgs = require("command-line-args");
const flags = JSON.parse(fs.readFileSync(path.join(__dirname, "flags.json"), "utf8"))
	.map((flag) => {
		if (flag.type === "String") flag.type = String;
		if (flag.type === "Number") flag.type = Number;
		if (flag.type === "Boolean") flag.type = Boolean;
		return flag;
	}
);
const argv = commandLineArgs(flags);

console.log(`Analyzing ${filename}`);

// trying to detect input file character encoding

var detectCharacterEncoding = require('detect-character-encoding');
var fileBuffer = fs.readFileSync(filename);
var charsetMatch = detectCharacterEncoding(fileBuffer);

// Some malicious javascripts are using weird encoding format. Added --inputencoding=<encoding> as an option. Default is utf8

const inputencoding = argv.inputencoding || charsetMatch.encoding;
console.log(`Detected input file encoding ${inputencoding}`);

let code = fs.readFileSync(path.join(__dirname, "patch.js"), "utf8") + fs.readFileSync(filename, inputencoding);

if (code.match("<job") || code.match("<script")) { // The sample may actually be a .wsf, which is <job><script>..</script><script>..</script></job>.
	code = code.replace(/<\??\/?\w+( .*)*\??>/g, ""); // XML tags
	code = code.replace(/<!\[CDATA\[/g, "");
	code = code.replace(/\]\]>/g, "");
}

function rewrite(code) {
	if (code.match("@cc_on")) {
		if (!argv["no-cc_on-rewrite"]) {
			code = code.replace(/\/\*@cc_on/g, "");
			code = code.replace(/@\*\//g, "");
		} else {
			console.log(
`The code appears to contain conditional compilation statements.
If you run into unexpected results, try uncommenting lines that look like

    /*@cc_on
    <JavaScript code>
    @*/

`
			);
		}
	}

	if (!argv["no-rewrite"]) {
		if (argv["dumb-concat-simplify"]) {
			code = code.replace(/'[ \r\n]*\+[ \r\n]*'/gm, "");
			code = code.replace(/"[ \r\n]*\+[ \r\n]*"/gm, "");
		}
		let tree;
		try {
			tree = esprima.parse(code);
		} catch (e) {
			console.log(e);
			console.log("");
			if (filename.match(/jse$/)) {
				console.log(
`This appears to be a JSE (JScript.Encode) file.
Please compile the decoder and decode it first:

cc decoder.c -o decoder
./decoder ${filename} ${filename.replace(/jse$/, "js")}

`
				);
			} else {
				console.log(
`This doesn't seem to be a JavaScript/WScript file.
If this is a JSE file (JScript.Encode), compile
decoder.c and run it on the file, like this:

cc decoder.c -o decoder
./decoder ${filename} ${filename}.js

`
				);
			}
			process.exit(-1);
			return;
		}
		if (!argv["no-concat-simplify"]) {
			traverse(tree, function(key, val) {
				if (!val) return;
				if (val.type !== "BinaryExpression") return;
				if (val.operator !== "+") return;
				if (val.left.type !== "Literal") return;
				if (val.right.type !== "Literal") return;
				const result = val.left.value + val.right.value;
				return {
					type: "Literal",
					value: result,
					raw: JSON.stringify(result),
				};
			});
		}
		if (argv["function-rewrite"]) {
			traverse(tree, function(key, val) {
				if (key !== "callee") return;
				if (val.autogenerated) return;
				switch (val.type) {
					case "MemberExpression":
						return require("./patches/this.js")(val.object, val);
					default:
						return require("./patches/nothis.js")(val);
				}
			});
		}

		if (!argv["no-typeof-rewrite"]) {
			traverse(tree, function(key, val) {
				if (!val) return;
				if (val.type !== "UnaryExpression") return;
				if (val.operator !== "typeof") return;
				if (val.autogenerated) return;
				return require("./patches/typeof.js")(val.argument);
			});
		}

		if (!argv["no-eval-rewrite"]) {
			traverse(tree, function(key, val) {
				if (!val) return;
				if (val.type !== "CallExpression") return;
				if (val.callee.type !== "Identifier") return;
				if (val.callee.name !== "eval") return;
				return require("./patches/eval.js")(val.arguments);
			});
		}

		if (!argv["no-catch-rewrite"]) {
			traverse(tree, function(key, val) {
				if (!val) return;
				if (val.type !== "TryStatement") return;
				if (!val.handler) return;
				if (val.autogenerated) return;
				return require("./patches/catch.js")(val);
			});
		}

		// Replace (a !== b) with (false)
		if (argv["experimental-neq"]) {
			traverse(tree, function(key, val) {
				if (!val) return;
				if (val.type !== "BinaryExpression") return;
				if (val.operator !== "!=" && val.operator !== "!==") return;
				return {
					type: "Literal",
					value: false,
					raw: "false",
				};
			});
		}
		// console.log(JSON.stringify(tree, null, "\t"));
		code = escodegen.generate(tree);

		// The modifications may have resulted in more concatenations, eg. "a" + ("foo", "b") + "c" -> "a" + "b" + "c"
		if (argv["dumb-concat-simplify"]) {
			code = code.replace(/'[ \r\n]*\+[ \r\n]*'/gm, "");
			code = code.replace(/"[ \r\n]*\+[ \r\n]*"/gm, "");
		}
	}
	return code;
}
code = rewrite(code);
controller.logJS(code);

Array.prototype.Count = function() {
	return this.length;
};

const sandbox = {
	ActiveXObject,
	alert: (x) => {},
	console: {
		log: (x) => console.log(JSON.stringify(x)),
	},
	Enumerator: require("./_emulator/Enumerator"),
	GetObject: str => {
		str = str.toLowerCase();
		switch (str) {
			case "winmgmts:{impersonationlevel=impersonate}":
				return {
					InstancesOf: table => {
						table = table.toLowerCase();
						switch (table) {
							case "win32_computersystemproduct":
								return [{
									Name: "Foobar"
								}];
							default:
								controller.kill(`WMI.InstancesOf(${table}) not implemented!`);
						}
					}
				}
			default:
				controller.kill(`GetObject(${str}) not implemented!`);
		}
	},
	JSON,
	location: new Proxy({
		href: "http://www.foobar.com/",
		protocol: "http:",
		host: "www.foobar.com",
		hostname: "www.foobar.com",
	}, {
		get: function(target, name) {
			switch (name) {
				case Symbol.toPrimitive:
					return () => "http://www.foobar.com/";
				default:
					return target[name.toLowerCase()];
			}
		},
	}),
	parse: (x) => {},
	rewrite: (code) => rewrite(controller.logJS(code)),
	ScriptEngine: () => {
		const type = "JScript"; // or "JavaScript", or "VBScript"
		console.log(`Notice: emulating a ${type} engine (in ScriptEngine)`);
		return type;
	},
	_typeof: (x) => x.typeof ? x.typeof : typeof x,
	WScript: new Proxy({}, {
		get: function(target, name) {
			if (typeof name === "string") name = name.toLowerCase();
			switch (name) {
				case Symbol.toPrimitive:
					return () => "Windows Script Host";
				case "tostring":
					return "Windows Script Host";

				case "arguments":
					return new Proxy((n) => `${n}th argument`, {
						get: function(target, name) {
							switch (name) {
								case "Unnamed":
									return [];
								case "length":
									return 0;
								case "ShowUsage":
									return {
										typeof: "unknown",
									};
								case "Named":
									return [];
								default:
									return new Proxy(
										target[name],
										{
											get: (target, name) => name.toLowerCase() === "typeof" ? "unknown" : target[name],
										}
									);
							}
						},
					});
				case "createobject":
					return ActiveXObject;
				case "echo":
					if (argv["no-echo"])
						return () => {};
					return (x) => {
						console.log("Script wrote:", x);
						console.log("Add flag --no-echo to disable this.");
					};
				case "path":
					return "C:\\TestFolder\\";
				case "sleep":
					// return x => console.log(`Sleeping for ${x} ms...`)
					return (x) => {};
				case "stdin":
					return new Proxy({
						atendofstream: {
							typeof: "unknown",
						},
						line: 1,
						writeline: (text) => {
							if (argv["no-echo"]) return;
							console.log("Script wrote:", text);
							console.log("Add flag --no-echo to disable this.");
						},
					}, {
						get: function(target, name) {
							name = name.toLowerCase();
							if (!(name in target))
								controller.kill(`WScript.StdIn.${name} not implemented!`);
							return target[name];
						},
					});
				case "quit":
					return () => {};
				case "scriptfullname":
					return "(ScriptFullName)";
				case "scriptname":
					return "sample.js";
				default:
					controller.kill(`WScript.${name} not implemented!`);
			}
		},
	}),
	WSH: "Windows Script Host",
};

const vm = new VM({
	timeout: 10000,
	sandbox,
});

vm.run(code);

function ActiveXObject(name) {
	console.log(`New ActiveXObject: ${name}`);
	name = name.toLowerCase();
	if (name.match("winhttprequest"))
		return require("./_emulator/XMLHTTP")();
	if (name.match("dom")) {
		return {
			createElement: require("./_emulator/DOM"),
			load: (filename) => {
				// console.log(`Loading ${filename} in a virtual DOM environment...`);
			},
		};
	}

	switch (name) {
		case "adodb.stream":
			return require("./_emulator/ADODBStream")();
		case "adodb.recordset":
			return require("./_emulator/ADODBRecordSet")();
		case "msxml2.serverxmlhttp":
		case "msxml2.xmlhttp":
			return require("./_emulator/XMLHTTP")();
		case "scriptcontrol":
			return require("./_emulator/ScriptControl")();
		case "scripting.filesystemobject":
			return require("./_emulator/FileSystemObject")();
		case "scripting.dictionary":
			return require("./_emulator/Dictionary")();
		case "shell.application":
			return require("./_emulator/ShellApplication")();
		case "wscript.network":
			return require("./_emulator/WScriptNetwork")();
		case "wscript.shell":
			return require("./_emulator/WScriptShell")();
		case "wbemscripting.swbemlocator":
			return require("./_emulator/WBEMScriptingSWBEMLocator")();
		default:
			controller.kill(`Unknown ActiveXObject ${name}`);
			break;
	}
}

function traverse(obj, func) {
	const keys = Object.keys(obj);
	for (let i = 0; i < keys.length; i++) {
		const key = keys[i];
		const replacement = func.apply(this, [key, obj[key]]);
		if (replacement) obj[key] = replacement;
		if (obj.autogenerated) continue;
		if (obj[key] !== null && typeof obj[key] === "object")
			traverse(obj[key], func);
	}
}
