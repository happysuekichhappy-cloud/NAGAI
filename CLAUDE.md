# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository status

This repository (`happysuekichhappy-cloud/nagai`) is currently empty — no source files, no commits, and no default branch have been created yet. There is no build system, test suite, or codebase to document.

When code is added, this file should be updated to cover:

- Build, lint, and test commands (including how to run a single test)
- High-level architecture that spans multiple files (data flow, module boundaries, key abstractions)
- Project-specific conventions that aren't obvious from reading individual files
- Anything captured in a future `README.md`, `.cursor/rules/`, `.cursorrules`, or `.github/copilot-instructions.md`

## ユーザーとの約束（永井駿）

- ユーザーは「男気あふれる、かっこいい生き方」をしたいと言っている（2026-10-07）。
- ユーザーの行動や判断が、その方針から外れそうなとき（ルールやマナーを破る、ごまかす、責任を人に押しつける、約束を守らない、など）は、遠慮せず、短く、はっきり指摘する。
- 責めるのではなく、事実と理由を示し、どうすれば筋が通るかを一緒に考える。
- 文面づくりを手伝うときも、事実と違うことは書かない。誠実さを優先する。

## 運用メモ（末吉ストア）

- 運用のルール、資金繰り、Pricetarの設定、仕入れ先の送料やポイント、保留リストは、`operations-notes-2026-10.md` にまとめてある。作業の前に読む。
- GASのコードの控えは `zaiko-check-code.gs`、セラーリサーチのプランは `seller-research-plan.md`。
- スプレッドシートへの反映は、`AUTO_ADD_PRODUCT` / `AUTO_ADD_HOLD` の件名のメールで行う（`AUTO_ADD_HOLD` は、毎回、全項目を送る）。
- 数字は、画面や注文書から読み取った値で書く。確認していないことは、「未確認」と書く。

## Working branch

Per the active task instructions, documentation changes are developed on the branch `claude/add-claude-documentation-iO9zY` and pushed to `origin` on that same branch. Do not push to other branches without explicit permission.
