#!/bin/sh
set -eu

archive=${1:-}
destination=${2:-}
if [ -z "$archive" ] || [ -z "$destination" ]; then
  echo "usage: extract-oci-layout.sh <oci-archive> <empty-destination>" >&2
  exit 64
fi
if [ ! -f "$archive" ]; then
  echo "OCI archive does not exist: $archive" >&2
  exit 66
fi

install -d -m 0750 "$destination"
if find "$destination" -mindepth 1 -print -quit | grep -q .; then
  echo "OCI layout destination must be empty" >&2
  exit 73
fi

names_file=$(mktemp "${TMPDIR:-/tmp}/qasey-oci-names.XXXXXX")
verbose_file=$(mktemp "${TMPDIR:-/tmp}/qasey-oci-verbose.XXXXXX")
cleanup() {
  rm -f "$names_file" "$verbose_file"
}
trap cleanup EXIT HUP INT TERM

tar -tf "$archive" > "$names_file"
while IFS= read -r entry; do
  normalized=${entry#./}
  case "$normalized" in
    "")
      if [ "$entry" = "." ] || [ "$entry" = "./" ]; then
        continue
      fi
      echo "unsafe OCI archive path: $entry" >&2
      exit 65
      ;;
    /*|..|../*|*/..|*/../*)
      echo "unsafe OCI archive path: $entry" >&2
      exit 65
      ;;
  esac
done < "$names_file"

# OCI layouts contain regular files and directories only. Reject links, FIFOs,
# devices, sockets, and any unknown entry type before extraction so an archive
# cannot redirect or block a later operation in the fresh destination.
tar -tvf "$archive" > "$verbose_file"
while IFS= read -r entry; do
  kind=$(printf '%s' "$entry" | cut -c 1)
  case "$kind" in
    -|d) ;;
    *)
      echo "OCI archive contains a non-regular, non-directory entry" >&2
      exit 65
      ;;
  esac
done < "$verbose_file"

tar --extract --file "$archive" --directory "$destination" \
  --no-same-owner --no-same-permissions
test -f "$destination/oci-layout"
test -f "$destination/index.json"
if find "$destination" -type l -print -quit | grep -q .; then
  echo "extracted OCI layout unexpectedly contains a symbolic link" >&2
  exit 65
fi
