import * as shared from '@volar/shared';
import * as vue from '@volar/vue-language-service';
import { TextDocument } from 'vscode-languageserver-textdocument';
import * as vscode from 'vscode-languageserver';
import type { Projects } from '../projects';
import { fileRenamings, renameFileContentCache, getScriptText } from '../project';
import { getDocumentSafely } from '../utils';

export function register(
	ts: typeof import('typescript/lib/tsserverlibrary'),
	connection: vscode.Connection,
	documents: vscode.TextDocuments<TextDocument>,
	projects: Projects,
	features: NonNullable<shared.ServerInitializationOptions['languageFeatures']>,
	params: vscode.InitializeParams,
) {
	connection.onCompletion(async handler => {
		return worker(handler.textDocument.uri, async vueLs => {
			const list = await vueLs.doComplete(
				handler.textDocument.uri,
				handler.position,
				handler.context,
			);
			const insertReplaceSupport = params.capabilities.textDocument?.completion?.completionItem?.insertReplaceSupport ?? false;
			if (!insertReplaceSupport && list) {
				for (const item of list.items) {
					if (item.textEdit && vscode.InsertReplaceEdit.is(item.textEdit)) {
						item.textEdit = vscode.TextEdit.replace(item.textEdit.insert, item.textEdit.newText);
					}
				}
			}
			return list;
		});
	});
	connection.onCompletionResolve(async item => {

		const uri = (item.data as { uri?: string; } | undefined)?.uri;
		if (!uri) {
			return item;
		}

		const activeSel = features.completion?.getDocumentSelectionRequest
			? await connection.sendRequest(shared.GetEditorSelectionRequest.type)
			: undefined;
		const newPosition = activeSel?.textDocument.uri.toLowerCase() === uri.toLowerCase() ? activeSel.position : undefined;

		return await worker(uri, async vueLs => {
			return vueLs.doCompletionResolve(item, newPosition) ?? item;
		}) ?? item;
	});
	connection.onHover(async handler => {
		return worker(handler.textDocument.uri, vueLs => {
			return vueLs.doHover(handler.textDocument.uri, handler.position);
		});
	});
	connection.onSignatureHelp(async handler => {
		return worker(handler.textDocument.uri, vueLs => {
			return vueLs.getSignatureHelp(handler.textDocument.uri, handler.position, handler.context);
		});
	});
	connection.onPrepareRename(async handler => {
		return worker(handler.textDocument.uri, vueLs => {
			return vueLs.prepareRename(handler.textDocument.uri, handler.position);
		});
	});
	connection.onRenameRequest(async handler => {
		return worker(handler.textDocument.uri, vueLs => {
			return vueLs.doRename(handler.textDocument.uri, handler.position, handler.newName);
		});
	});
	connection.onCodeLens(async handler => {
		return worker(handler.textDocument.uri, vueLs => {
			return vueLs.doCodeLens(handler.textDocument.uri);
		});
	});
	connection.onCodeLensResolve(async codeLens => {

		const uri = (codeLens.data as any)?.uri as string | undefined; // TODO
		if (!uri) {
			return codeLens;
		}

		return await worker(uri, vueLs => {
			return vueLs.doCodeLensResolve(codeLens) ?? codeLens;
		}) ?? codeLens;
	});
	connection.onExecuteCommand(async (handler, token, workDoneProgress) => {

		if (handler.command === vue.executePluginCommand) {

			const args = handler.arguments as vue.ExecutePluginCommandArgs | undefined;
			if (!args) {
				return;
			}

			return worker(args[0], vueLs => {
				return vueLs.doExecuteCommand(handler.command, args, {
					token,
					workDoneProgress,
					applyEdit: (paramOrEdit) => connection.workspace.applyEdit(paramOrEdit),
					sendNotification: (type, params) => connection.sendNotification(type, params),
				});
			});
		}

		if (handler.command === 'volar.server.convertTagNameCasing') {

			const args = handler.arguments as [string, 'kebab' | 'pascal'] | undefined;
			if (!args) {
				return;
			}

			return worker(args[0], vueLs => {
				return vueLs.doExecuteCommand(
					vue.executePluginCommand,
					[
						args[0],
						undefined,
						vscode.Command.create(
							'',
							vue.convertTagNameCasingCommand,
							...<vue.ConvertTagNameCasingCommandArgs>[
								args[0],
								args[1],
							]),
					], {
					token,
					workDoneProgress,
					applyEdit: (paramOrEdit) => connection.workspace.applyEdit(paramOrEdit),
					sendNotification: (type, params) => connection.sendNotification(type, params),
				});
			});
		}
	});
	connection.onCodeAction(async handler => {
		return worker(handler.textDocument.uri, async vueLs => {
			const codeActions = await vueLs.doCodeActions(handler.textDocument.uri, handler.range, handler.context) ?? [];
			for (const codeAction of codeActions) {
				if (codeAction.data && typeof codeAction.data === 'object') {
					(codeAction.data as any).uri = handler.textDocument.uri;
				}
				else {
					codeAction.data = { uri: handler.textDocument.uri };
				}
			}
			return codeActions;
		});
	});
	connection.onCodeActionResolve(async codeAction => {

		const uri: string | undefined = (codeAction.data as any)?.uri;
		if (!uri) {
			return codeAction;
		}

		return await worker(uri, vueLs => {
			return vueLs.doCodeActionResolve(codeAction);
		}) ?? codeAction;
	});
	connection.onReferences(async handler => {
		return worker(handler.textDocument.uri, vueLs => {
			return vueLs.findReferences(handler.textDocument.uri, handler.position);
		});
	});
	connection.onImplementation(async handler => {
		return worker(handler.textDocument.uri, vueLs => {
			return vueLs.findImplementations(handler.textDocument.uri, handler.position);
		});
	});
	connection.onDefinition(async handler => {
		return worker(handler.textDocument.uri, vueLs => {
			return vueLs.findDefinition(handler.textDocument.uri, handler.position);
		});
	});
	connection.onTypeDefinition(async handler => {
		return worker(handler.textDocument.uri, vueLs => {
			return vueLs.findTypeDefinition(handler.textDocument.uri, handler.position);
		});
	});
	connection.onDocumentHighlight(async handler => {
		return worker(handler.textDocument.uri, vueLs => {
			return vueLs.findDocumentHighlights(handler.textDocument.uri, handler.position);
		});
	});
	connection.onDocumentLinks(async handler => {
		return worker(handler.textDocument.uri, vueLs => {
			return vueLs.findDocumentLinks(handler.textDocument.uri);
		});
	});
	connection.onWorkspaceSymbol(async (handler, token) => {

		let results: vscode.SymbolInformation[] = [];

		for (const workspace of projects.workspaces.values()) {
			let projects = [...workspace.projects.values()];
			projects = projects.length ? projects : [workspace.getInferredProject()];
			for (const project of projects) {

				if (token.isCancellationRequested)
					return;

				const vueLs = (await project).getLanguageService();

				results = results.concat(await vueLs.findWorkspaceSymbols(handler.query));
			}
		}

		return results;
	});
	connection.languages.callHierarchy.onPrepare(async handler => {
		return await worker(handler.textDocument.uri, async vueLs => {
			const items = await vueLs.callHierarchy.doPrepare(handler.textDocument.uri, handler.position);
			if (items) {
				for (const item of items) {
					if (typeof item.data !== 'object') item.data = {};
					(item.data as any).__uri = handler.textDocument.uri;
				}
			}
			return items?.length ? items : null;
		}) ?? [];
	});
	connection.languages.callHierarchy.onIncomingCalls(async handler => {

		const data = handler.item.data as { __uri?: string; } | undefined;
		const uri = data?.__uri ?? handler.item.uri;

		return await worker(uri, vueLs => {
			return vueLs.callHierarchy.getIncomingCalls(handler.item);
		}) ?? [];
	});
	connection.languages.callHierarchy.onOutgoingCalls(async handler => {

		const data = handler.item.data as { __uri?: string; } | undefined;
		const uri = data?.__uri ?? handler.item.uri;

		return await worker(uri, vueLs => {
			return vueLs.callHierarchy.getOutgoingCalls(handler.item);
		}) ?? [];
	});
	connection.languages.semanticTokens.on(async (handler, token, _, resultProgress) => {
		return await worker(handler.textDocument.uri, async vueLs => {

			const result = await vueLs?.getSemanticTokens(
				handler.textDocument.uri,
				undefined,
				token,
				tokens => resultProgress?.report(buildTokens(tokens)),
			) ?? [];

			return buildTokens(result);
		}) ?? buildTokens([]);
	});
	connection.languages.semanticTokens.onRange(async (handler, token, _, resultProgress) => {
		return await worker(handler.textDocument.uri, async vueLs => {

			const result = await vueLs?.getSemanticTokens(
				handler.textDocument.uri,
				handler.range,
				token,
				tokens => resultProgress?.report(buildTokens(tokens)),
			) ?? [];

			return buildTokens(result);
		}) ?? buildTokens([]);
	});
	connection.languages.inlayHint.on(async handler => {
		return worker(handler.textDocument.uri, vueLs => {
			return vueLs.getInlayHints(handler.textDocument.uri, handler.range);
		});
	});
	connection.workspace.onWillRenameFiles(async handler => {

		const hasTsFile = handler.files.some(file => file.newUri.endsWith('.vue') || file.newUri.endsWith('.ts') || file.newUri.endsWith('.tsx'));
		const config: 'prompt' | 'always' | 'never' | null | undefined = await connection.workspace.getConfiguration(hasTsFile ? 'typescript.updateImportsOnFileMove.enabled' : 'javascript.updateImportsOnFileMove.enabled');

		if (config === 'always') {
			const renaming = new Promise<void>(async resolve => {
				for (const file of handler.files) {
					const renameFileContent = getScriptText(documents, shared.uriToFsPath(file.oldUri), ts.sys);
					if (renameFileContent) {
						renameFileContentCache.set(file.oldUri, renameFileContent);
					}
				}
				await shared.sleep(0);
				const edit = await worker();
				if (edit) {
					if (edit.documentChanges) {
						for (const change of edit.documentChanges) {
							if (vscode.TextDocumentEdit.is(change)) {
								for (const file of handler.files) {
									if (change.textDocument.uri === file.oldUri) {
										change.textDocument.uri = file.newUri;
										change.textDocument.version = getDocumentSafely(documents, file.newUri)?.version ?? change.textDocument.version;
									}
								}
							}
						}
					}
					connection.workspace.applyEdit(edit);
				}
				resolve();
			});
			fileRenamings.add(renaming);
			(async () => {
				await renaming;
				fileRenamings.delete(renaming);
				renameFileContentCache.clear();
			})();
		}

		if (config === 'prompt')
			return await worker();

		return null;

		async function worker() {
			const edits = (await Promise.all(handler.files
				.map(async file => {
					const vueLs = await getLanguageService(file.oldUri);
					return vueLs?.getEditsForFileRename(file.oldUri, file.newUri);
				}))).filter(shared.notEmpty);
			if (edits.length) {
				const result = edits[0];
				vue.mergeWorkspaceEdits(result, ...edits.slice(1));
				return result;
			}
			return null;
		}
	});
	connection.onRequest(shared.AutoInsertRequest.type, async handler => {
		return worker(handler.textDocument.uri, vueLs => {
			return vueLs.doAutoInsert(handler.textDocument.uri, handler.position, handler.options);
		});
	});

	async function worker<T>(uri: string, cb: (vueLs: vue.LanguageService) => T) {
		const vueLs = await getLanguageService(uri);
		if (vueLs) {
			return cb(vueLs);
		}
	}
	function buildTokens(tokens: vue.SemanticToken[]) {
		const builder = new vscode.SemanticTokensBuilder();
		const sortedTokens = tokens.sort((a, b) => a[0] - b[0] === 0 ? a[1] - b[1] : a[0] - b[0]);
		for (const token of sortedTokens) {
			builder.push(...token);
		}
		return builder.build();
	}
	async function getLanguageService(uri: string) {
		const project = (await projects.getProject(uri))?.project;
		return project?.getLanguageService();
	}
}
