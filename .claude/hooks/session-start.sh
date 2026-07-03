#!/bin/bash
set -euo pipefail

# SSH 커밋 서명 자동 설정
# ─────────────────────────────────────────────────────
# 회사 방화벽·공용 와이파이·집 등 세션을 여는 네트워크가 매번 달라도,
# SSH_SIGNING_KEY(환경 Secret)만 등록해두면 항상 동일하게 커밋 서명이 되도록
# 세션 시작 시마다 로컬 SSH 서명키를 복원하고 git을 설정한다.
# GPG와 달리 키서버·에이전트 등 외부 네트워크 요청이 전혀 없어 보안망 제약이 없다.

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

if [ -z "${SSH_SIGNING_KEY:-}" ]; then
  echo "SSH_SIGNING_KEY 환경변수(Secret)가 설정되지 않아 커밋 서명 설정을 건너뜁니다."
  exit 0
fi

mkdir -p "$HOME/.ssh"
printf '%s\n' "$SSH_SIGNING_KEY" > "$HOME/.ssh/signing_key"
chmod 600 "$HOME/.ssh/signing_key"

# 공개키도 함께 제공됐으면 같이 복원 (없어도 서명 자체는 개인키만으로 가능)
if [ -n "${SSH_SIGNING_KEY_PUB:-}" ]; then
  printf '%s\n' "$SSH_SIGNING_KEY_PUB" > "$HOME/.ssh/signing_key.pub"
  chmod 644 "$HOME/.ssh/signing_key.pub"
fi

git config --global gpg.format ssh
git config --global user.signingkey "$HOME/.ssh/signing_key"
git config --global commit.gpgsign true

# committer 이메일이 GitHub 미인증 이메일(noreply@anthropic.com)이면 SSH 서명이 있어도
# GitHub가 "Unverified"로 표시할 수 있음 — GIT_AUTHOR_EMAIL이 Secret으로 등록돼 있으면 반영
if [ -n "${GIT_AUTHOR_EMAIL:-}" ]; then
  git config --global user.email "$GIT_AUTHOR_EMAIL"
fi
if [ -n "${GIT_AUTHOR_NAME:-}" ]; then
  git config --global user.name "$GIT_AUTHOR_NAME"
fi

echo "SSH 커밋 서명 설정 완료 (gpg.format=ssh)."
