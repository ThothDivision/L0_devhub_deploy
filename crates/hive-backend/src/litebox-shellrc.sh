exec 2>&1
# Interactive-shell guard (see SHELL_RC_BYTES in litebox.rs): under litebox's
# fork emulation the child bash forks for a command it cannot find, and that
# child dies `glibc detected an invalid stdio handle`, wedging the session.
# Answer "command not found" in the PARENT (no fork) instead.
if [ -n "${BASH_VERSION-}" ] && [ -c /dev/null ]; then
  __hive_nf() {
    __hive_c=$BASH_COMMAND
    while :; do
      __hive_w=${__hive_c%%[[:space:]]*}
      case $__hive_w in
        [A-Za-z_]*=*)
          case ${__hive_w%%=*} in *[!A-Za-z0-9_]*) return 0 ;; esac
          case ${__hive_w#*=} in *[\'\"\\\$\`\(\)\;\&\|\<\>]*) return 0 ;; esac
          [ "$__hive_c" = "$__hive_w" ] && return 0
          __hive_c=${__hive_c#"$__hive_w"}
          __hive_c=${__hive_c#"${__hive_c%%[![:space:]]*}"}
          ;;
        *) break ;;
      esac
    done
    case $__hive_w in
      ''|[!A-Za-z0-9_]*|*[!A-Za-z0-9_.+-]*) return 0 ;;
    esac
    command -v -- "$__hive_w" >/dev/null 2>&1 && return 0
    printf '%s: %s: command not found\n' "${0##*/}" "$__hive_w" >&2
    return 1
  }
  shopt -s extdebug
  trap '__hive_nf' DEBUG
fi
