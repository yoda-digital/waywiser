/**
 * waywiser-*mobile/actions — Termux notification argv builder (spec 08 §4/§12).
 *
 * Action strings passed to `termux-notification --action` / `--button*-action`
 * are executed by `dash -c`. To eliminate shell-injection risk from every
 * user-facing payload (titles, bodies, replies, prompts), we only ever embed
 * two fixed shapes:
 *
 *   1. `<bin>/waywiser-do <token>`
 *   2. `<bin>/waywiser-reply <token> "$REPLY"`
 *   3. `termux-fingerprint … | grep -q '"success":true' && <bin>/waywiser-approve <token> yes || <bin>/waywiser-approve <token> no`
 *
 * `<bin>` is a whitelist-validated absolute path resolved once at register
 * time; `<token>` is a hex UUID we mint. `$REPLY` is env-expanded by dash
 * (per termux-notification --help-actions) and lands as an argv element in
 * the callback — never as a shell fragment we re-parse.
 *
 * The action strings are single-quoted so the outer dash -c does not expand
 * anything besides `$REPLY` (which we deliberately double-quote to preserve
 * whitespace).
 */
import * as path from "node:path";
import { issueToken } from "./inbox.js";
import type { NotifyAction, TermuxActionBuilder } from "../notify.js";

const HEX_TOKEN_RE = /^[a-f0-9-]{16,}$/i;

function assertToken(t: string): void {
	if (!HEX_TOKEN_RE.test(t)) throw new Error(`refusing to embed unsafe token: ${JSON.stringify(t)}`);
}

/**
 * Absolute paths to the callback binaries. Only set after /mobile setup or
 * explicit configureBinaries() from the extension entry. When missing, we
 * refuse to build action args (safer than shipping half-wired notifications).
 */
export interface BinPaths {
	do: string;
	reply: string;
	approve: string;
}

function assertAbsolute(p: string, name: string): void {
	if (!path.isAbsolute(p)) throw new Error(`bin.${name} must be an absolute path, got: ${JSON.stringify(p)}`);
	// Refuse whitespace, quotes, shell metacharacters. Paths inside Termux
	// prefix are safe; be strict.
	if (/[\s"'`$\\|;&<>\n\r]/.test(p)) throw new Error(`bin.${name} contains unsafe characters`);
}

/**
 * Build the TermuxActionBuilder that notify.ts calls. Returns a builder
 * whose `buildArgs` mints inbox tokens for each action and returns argv
 * extensions ready to concatenate onto the base `termux-notification` call.
 */
export function makeActionBuilder(bins: BinPaths): TermuxActionBuilder {
	assertAbsolute(bins.do, "do");
	assertAbsolute(bins.reply, "reply");
	assertAbsolute(bins.approve, "approve");

	return {
		buildArgs(actions: NotifyAction[], defaultTTLMs: number): string[] {
			const args: string[] = [];
			// Only 3 buttons are supported by Termux:API. Extra actions are
			// dropped with a stderr note; caller is responsible for prioritizing.
			const slice = actions.slice(0, 3);
			if (actions.length > 3) {
				process.stderr.write(`waywiser/mobile: dropped ${actions.length - 3} notification action(s) — Android limit is 3 buttons\n`);
			}
			slice.forEach((action, i) => {
				const button = `--button${i + 1}` as const;
				const buttonAction = `--button${i + 1}-action` as const;
				const token = issueToken(action.intent, defaultTTLMs);
				assertToken(token);
				args.push(button, action.label);
				if (action.directReply || action.intent.kind === "reply") {
					// Direct-Reply: user gets an inline input; $REPLY holds the text.
					args.push(buttonAction, `${bins.reply} ${token} "$REPLY"`);
				} else if (action.intent.kind === "approve" && action.intent.requiresBiometric) {
					// Biometric-gated approve: on success invoke approve <tok> yes; on
					// failure invoke approve <tok> no. Bash short-circuit keeps this a
					// single --button*-action string.
					args.push(
						buttonAction,
						`termux-fingerprint -t 'Approve ${token}' | grep -q '"success":true' && ${bins.approve} ${token} yes || ${bins.approve} ${token} no`,
					);
				} else {
					args.push(buttonAction, `${bins.do} ${token}`);
				}
			});
			return args;
		},
	};
}
