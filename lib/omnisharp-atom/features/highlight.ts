import ClientManager = require('../../omni-sharp-server/client-manager');
import Client = require("../../omni-sharp-server/client");
import {DriverState} from "omnisharp-client";
import OmniSharpAtom = require('../omnisharp-atom');
import {each, indexOf, extend, has, map, flatten, contains, any, range, remove, pull} from "lodash";
import _ = require('lodash');
import {Observable, Subject, Scheduler} from "rx";
var AtomGrammar = require((<any> atom).config.resourcePath + "/node_modules/first-mate/lib/grammar.js");
var Range: typeof TextBuffer.Range = <any>require('atom').Range;

class Highlight {
    public activate() {
        var editors = [];
        OmniSharpAtom.onEditor((editor: Atom.TextEditor) => {
            editor['_setGrammar'] = editor.setGrammar;
            editor.setGrammar = setGrammar;
            editor.setGrammar(editor.getGrammar());
            editor.displayBuffer.tokenizedBuffer['_buildTokenizedLineForRowWithText'] = editor.displayBuffer.tokenizedBuffer.buildTokenizedLineForRowWithText;
            (<any>editor.displayBuffer.tokenizedBuffer).buildTokenizedLineForRowWithText = function(row) {
                editor.getGrammar()['__row__'] = row;
                return editor.displayBuffer.tokenizedBuffer['_buildTokenizedLineForRowWithText'].apply(this, arguments);
            };
            (<any>editor.displayBuffer.tokenizedBuffer).silentRetokenizeLines = function() {
                var event, lastRow;
                lastRow = this.buffer.getLastRow();
                this.tokenizedLines = this.buildPlaceholderTokenizedLinesForRows(0, lastRow);
                this.invalidRows = [];
                this.invalidateRow(0);
                this.fullyTokenized = false;
            };
            editors.push(editor);
        });

        ClientManager.registerConfiguration(client => {
            var sub = client.state
                .where(state => state === DriverState.Connected)
                .subscribe(state => {
                    sub.dispose();
                    each(editors, editor => {
                        var client = ClientManager.getClientForEditor(editor);
                        if (client) {
                            client.request<HighlightRequest, HighlightResponse[]>("highlight", {
                                FileName: editor.getPath(),
                                Lines: []
                            })
                                .subscribe(responses => {
                                    editor.getGrammar().responses = responses;
                                    editor.displayBuffer.tokenizedBuffer.retokenizeLines();
                                });
                        }
                    })
                });
        })
    }
}

interface HighlightRequest {
    FileName: string;
    Lines?: number[];
}

interface HighlightResponse {
    Start: { Character: number; Line: number; };
    End: { Character: number; Line: number; };
    Kind: string;
}

function Grammar(editor: Atom.TextEditor, base: FirstMate.Grammar) {
    this.editor = editor;
    this.base = base;
    var handleResponse = (responses: HighlightResponse[]) => {
        this.responses = responses;
    }

    var client = ClientManager.getClientForEditor(this.editor);
    if (client) {
        client.request<HighlightRequest, HighlightResponse[]>("highlight", {
            FileName: this.editor.getPath(),
            Lines: []
        })
            .subscribe(responses => {
                this.responses = responses;
                editor.displayBuffer.tokenizedBuffer.retokenizeLines();
            });
    }

    editor.buffer.preemptDidChange((e) => {
        var {oldRange, newRange} = e,
            start = oldRange.start.row,
            end = oldRange.end.row,
            delta = newRange.end.row - oldRange.end.row;
        // Any new lines... we need to full highlight again.
        let retokenize = false;
        if (any(e.newText, (z: string) => z.charCodeAt(0) === 10) || any(e.oldText, (z: string) => z.charCodeAt(0) === 10)) {
            //this.responses = [];
            retokenize = true;
        }
        if (!this.responses || !this.responses.length) {
            retokenize = true;
        }

        var client = ClientManager.getClientForEditor(this.editor);
        if (client) {
            var request: HighlightRequest = <any>client.makeRequest(editor);
            client.request<HighlightRequest, HighlightResponse[]>("highlight", request)
                .subscribe(responses => {
                    this.responses = responses;
                    if (retokenize) {
                        editor.displayBuffer.tokenizedBuffer['silentRetokenizeLines']();
                    }
                });
        }
    });
    this.responses = [];
}

function getHighlightRows(responses: HighlightResponse[], row: number) {
    return _(responses)
        .filter(response => findLine(response, row))
        .value();
}

extend(Grammar.prototype, AtomGrammar.prototype);

Grammar.prototype.omnisharp = true;
Grammar.prototype.tokenizeLine = function(line: string, ruleStack: any[], firstLine = false) {
    // BOM handling:
    // NOTE THERE ARE OTHER BOMS. I just wanted a proof of concept.
    // Feel free to add here if you know of ones that are giving you pain.
    if (firstLine
        && line.length > 1
        && (line.charCodeAt(0) == 0xFFFE || line.charCodeAt(0) == 0xFEFF)) {
        this.trailingWhiteSpaceLength = 1;
    }
    else {
        this.trailingWhiteSpaceLength = 0;
    }

    if (this.responses && this.responses.length) {
        var editor: Atom.TextEditor = this.editor;
        var row = this['__row__']

        var highlights = getHighlightRows(this.responses, row);

        if (!highlights.length) return this.base.tokenizeLine(line, ruleStack, firstLine);

        return this.convertCsTokensToAtomTokens(this.getCsTokensForLine(highlights, line, row, ruleStack, firstLine));
    } else {
        return this.base.tokenizeLine(line, ruleStack, firstLine);
    }
}

Grammar.prototype.convertCsTokensToAtomTokens = function(csTokensWithRuleStack) {
    var tokens = flatten(csTokensWithRuleStack.tokens).map((info: any) => {
        var atomToken = this.registry.createToken(info.str, ["source.cs"].concat(info.style));
        return atomToken;
    });

    return { tokens, ruleStack: csTokensWithRuleStack.ruleStack };
}

Grammar.prototype.getCsTokensForLine = function(highlights: HighlightResponse[], line: string, row: number, ruleStack: any[], firstLine): any {
    var ruleStack = [this.getInitialRule()/*output.finalLexState*/];

    // Start with trailing whitespace taken into account.
    // This is needed because classification for that is already done by ATOM internally (somehow)
    var totalLength = this.trailingWhiteSpaceLength;
    var tokens = map(highlights, highlight => {
        var results = [];
        var start = highlight.Start.Character + this.trailingWhiteSpaceLength;
        var end = highlight.End.Character + this.trailingWhiteSpaceLength;
        if (highlight.End.Line > highlight.Start.Line && highlight.End.Line !== row) {
            start = 0;
            end = line.length;
        }

        if (start > totalLength) {
            var whitespace = start - totalLength;
            for (let i = 0; i < whitespace; i++) {
                results.push({ style: ['whitespace'], str: ' ' });
            }
        }

        var str = line.substring(start, end);
        var style = getAtomStyleForToken(highlight, str);

        results.push({ style: [style], str: str });
        totalLength = end;
        return results;
    });

    if (line.length > totalLength) {
        tokens.push([{ style: ['whitespace'], str: line.substr(totalLength) }])
    }

    return { tokens, ruleStack };
}

/// NOTE: best way I have found for these is to just look at theme "less" files
// Alternatively just inspect the token for a .js file
function getAtomStyleForToken(token: HighlightResponse, str: string): string {
    switch (token.Kind) {
        case "punctuation":
            switch (str) {
                case '{':
                    return "punctuation.section.scope.begin.cs";
                case '}':
                    return "punctuation.section.scope.end.cs";
                case ')':
                    return "meta.brace.round.cs";
                case '(':
                    return "meta.brace.round.cs";
                case ';':
                    return "punctuation.terminator.statement.cs";
                default:
                    return "punctuation";
            }
        case "keyword":
            switch (str) {
                case 'static':
                case 'public':
                case 'private':
                case 'protected':
                case 'export':
                case 'get':
                case 'set':
                    return 'support.function';
                case 'class':
                case 'module':
                case 'var':
                    return 'storage.modifier';
                case 'function':
                    return 'storage.type.function';
                case 'string':
                case 'number':
                case 'void':
                case 'boolean':
                    return 'keyword';
                default:
                    return 'keyword';
            }
        case "number":
            return 'constant.numeric';
        case "string":
            return "string";
        case "operator":
            return 'keyword.operator.cs';
        case "comment":
            return 'comment.block';
        case "identifier":
            return 'identifier';
        case "class name":
        case "enum name":
        case "interface name":
            return 'support.class';
        //return 'support.function';
        case "preprocessor keyword":
            return 'constant.other.symbol';
        case "excluded code":
            return "comment.block";
        default:
            console.log(`unhandled Kind ${token.Kind}`);
            return 'keyword'; // This should not happen
    }
}

function findLine(response: HighlightResponse, index: number) {
    if (response.Start.Line === index || response.End.Line === index) {
        return true;
    }

    if (response.Start.Line < index && response.End.Line > index) {
        return true;
    }

    return false;
}

function setGrammar(grammar: FirstMate.Grammar): FirstMate.Grammar {
    if (!grammar['omnisharp'] && (grammar.name === 'C#' || grammar.name === 'C# Script File')) {
        var newGrammar = new Grammar(this, grammar);
        each(grammar, (x, i) => has(grammar, i) && (newGrammar[i] = x));
        grammar = newGrammar;
    }
    return this._setGrammar(grammar);
}

export = Highlight;
