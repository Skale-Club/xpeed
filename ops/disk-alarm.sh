#!/usr/bin/env bash
# Disk alarm for the Coolify server (the one that runs xpeed-db and the xpeed-files volume).
#
# WRITTEN, NOT INSTALLED. Nothing in this repository runs it. It is meant to be copied to the server by hand.
#
# What it does: checks `df` on / and on the Docker volumes folder. If either is above the threshold (80% by
# default) it prints a message to stdout and exits with 1 (so cron mails it, or a wrapper can react). If
# GH_TOKEN and GH_REPO are set in the environment and the `gh` CLI is installed, it also opens a GitHub issue
# titled "Disk alarm" (or comments on the open one, at most once a day; and closes it when the disk is fine again).
# GitHub then emails the repository owner. There are NO secrets in this file: the token comes from the environment.
#
# Settings (all optional, from the environment):
#   DISK_ALARM_THRESHOLD   percent, default 80 ("above" means strictly greater)
#   DOCKER_VOLUMES_DIR     default /var/lib/docker/volumes
#   GH_REPO                owner/name of the repository that receives the issue, for example Skale-Club/xpeed
#   GH_TOKEN               a fine-grained token limited to that one repository with "Issues: Read and write"
#
# Exit codes: 0 all fine, 1 a disk is above the threshold, 2 a path could not be checked.
#
# ---- How to install (on the Coolify server, as root, when the owner decides to) -------------------------
#   1. Install the GitHub CLI there (https://github.com/cli/cli/blob/trunk/docs/install_linux.md).
#   2. Copy this file:   install -m 700 ops/disk-alarm.sh /opt/xpeed-ops/disk-alarm.sh
#   3. Put the settings in a file only root can read (never in this script, never in git):
#        install -m 600 /dev/null /etc/xpeed-disk-alarm.env
#        printf 'GH_REPO=Skale-Club/xpeed\nGH_TOKEN=<fine-grained token, Issues write, this repo only>\n' > /etc/xpeed-disk-alarm.env
#   4. Add a cron line (crontab -e as root), every 30 minutes:
#        */30 * * * * set -a; . /etc/xpeed-disk-alarm.env; set +a; /opt/xpeed-ops/disk-alarm.sh >> /var/log/xpeed-disk-alarm.log 2>&1
#   5. Try it once by hand with a low threshold: DISK_ALARM_THRESHOLD=1 /opt/xpeed-ops/disk-alarm.sh
#      (it will open the "Disk alarm" issue; close it afterwards).
# --------------------------------------------------------------------------------------------------------
set -u

threshold="${DISK_ALARM_THRESHOLD:-80}"
volumes="${DOCKER_VOLUMES_DIR:-/var/lib/docker/volumes}"
host="$(hostname 2>/dev/null || echo server)"
title="Disk alarm"

usage_of() { df -P "$1" 2>/dev/null | awk 'NR==2 {gsub("%", "", $5); print $5}'; }

problems=""
errors=0
for path in / "$volumes"; do
  used="$(usage_of "$path")"
  if ! [[ "$used" =~ ^[0-9]+$ ]]; then
    echo "disk-alarm: could not read the usage of $path" >&2
    errors=1
    continue
  fi
  if [ "$used" -gt "$threshold" ]; then
    problems="${problems}${path} is ${used}% full (limit ${threshold}%). "
  fi
done

can_notify=false
if [ -n "${GH_TOKEN:-}" ] && [ -n "${GH_REPO:-}" ] && command -v gh >/dev/null 2>&1; then can_notify=true; fi

open_issue() {
  gh issue list --state open --limit 100 --json number,title --jq "[.[] | select(.title == \"$title\")][0].number // empty" 2>/dev/null
}

if [ -n "$problems" ]; then
  message="DISK ALARM on ${host}: ${problems}Free space (docker system df, old images, logs, backups) before the database or the files volume stops writing."
  echo "$(date -u '+%Y-%m-%d %H:%M:%S UTC') $message"
  if [ "$can_notify" = true ]; then
    number="$(open_issue)"
    if [ -z "$number" ]; then
      gh issue create --title "$title" --body "$message" >/dev/null || echo "disk-alarm: could not open the GitHub issue" >&2
    else
      last="$(gh issue view "$number" --json createdAt,comments --jq '([.createdAt] + [.comments[].createdAt]) | max' 2>/dev/null)"
      age=$(( $(date -u +%s) - $(date -u -d "${last:-1970-01-01T00:00:00Z}" +%s) ))
      if [ "$age" -ge 82800 ]; then gh issue comment "$number" --body "$message" >/dev/null || true; fi
    fi
  fi
  exit 1
fi

if [ "$errors" -ne 0 ]; then exit 2; fi

if [ "$can_notify" = true ]; then
  number="$(open_issue)"
  if [ -n "$number" ]; then
    gh issue comment "$number" --body "Recovered: disk usage on ${host} is back under ${threshold}%." >/dev/null \
      && gh issue close "$number" --reason completed >/dev/null || true
  fi
fi
exit 0
