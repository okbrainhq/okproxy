/*
 * OkProxy process helper: the app's private direct-child supervisor.
 *
 * Ownership contract
 * ------------------
 * The helper forks a workload leader into its own process group and keeps that
 * leader unreaped (waitid ... WNOWAIT) until the LAST group signal, so the
 * leader's live/zombie PID pins the group identity against reuse. Swift only
 * ever signals this helper PID; it never guesses a group by name.
 *
 * Liveness contract (this is the point of the revision)
 * ----------------------------------------------------
 * The helper MUST always exit, and must do so promptly. An earlier revision
 * treated every unexpected `kill(-pgid, ...)` error as an ownership failure and
 * then parked in `for (;;) pause();` forever. Darwin reports EPERM - NOT ESRCH -
 * for a group signal when the group has no signalable member left, which is the
 * ordinary case once the workload leader exited and only its unreaped zombie
 * stands in for the group. Reproduced on macOS:
 *
 *     leader alive                  -> killpg(SIGKILL) == 0
 *     leader exited (zombie, unreaped) -> killpg(SIGKILL) == -1 EPERM
 *     leader exited + live member   -> killpg(SIGKILL) == 0
 *     empty/unknown group           -> killpg(SIGKILL) == -1 ESRCH
 *
 * Because a leader-exit normally reached that branch, every supervised child
 * (the client AND every `node --version` probe) ended with a helper that never
 * exited. Swift's `waitpid` therefore never returned, the operation gate was
 * retained forever, and the app could no longer stop the client, start it, run
 * a repository update, or even quit. Linux returns 0 for the same group signal,
 * which is why the Linux fixture suite never caught it.
 *
 * Cleanup is now bounded and honest instead of unbounded and blocking:
 *   - group signals are classified (delivered / already empty / genuinely refused);
 *   - a refused group signal is swept member by member, then re-checked;
 *   - the leader is reaped with a bounded WNOHANG wait;
 *   - anything left unverified is recorded (`attention=1` in the run record) and
 *     reported with exit code 126, so the app can reclaim and say so.
 *
 * Exit codes
 *   0-124, 127-255  the workload's own exit status (passed through)
 *   125             helper setup failed before the workload was owned
 *   126             the workload leader was reaped, but descendant cleanup could
 *                   not be verified (run record retained with attention=1)
 *
 * Run record
 * ----------
 * When the launcher supplies OKPROXY_RUN_DIR and OKPROXY_RUN_META, the helper
 * writes <dir>/run-<role>-<helper pid>.record describing the helper, its
 * workload and the workload's process group. It is removed after a verified
 * clean cleanup and retained when cleanup is incomplete, which is what lets the
 * app reclaim leftovers from a helper that crashed or was killed externally.
 */
/* The group enumeration uses the BSD process table, which strict POSIX mode
   hides. Opt back into the Darwin namespace before any system header. */
#if defined(__APPLE__) && !defined(_DARWIN_C_SOURCE)
#define _DARWIN_C_SOURCE 1
#endif

#include <errno.h>
#include <fcntl.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/time.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

#ifdef __APPLE__
#include <sys/sysctl.h>
#endif

#define HELPER_SETUP_FAILURE 125
#define HELPER_CLEANUP_ATTENTION 126
#define GROUP_SWEEP_CAPACITY 512
#define WORKLOAD_STOP_GRACE_SECONDS 2.0
#define WORKLOAD_REAP_WINDOW_SECONDS 3.0
#define GROUP_SETTLE_SECONDS 0.5

static volatile sig_atomic_t stopping, force;
static char run_record_path[1024];

static double now_seconds(void) {
    struct timespec value;
    clock_gettime(CLOCK_MONOTONIC, &value);
    return (double)value.tv_sec + (double)value.tv_nsec / 1e9;
}

static double epoch_seconds(void) {
    struct timeval value;
    if (gettimeofday(&value, NULL) != 0) return 0;
    return (double)value.tv_sec + (double)value.tv_usec / 1e6;
}

static void sleep_milliseconds(long milliseconds) {
    struct timespec delay;
    delay.tv_sec = milliseconds / 1000;
    delay.tv_nsec = (milliseconds % 1000) * 1000000L;
    nanosleep(&delay, NULL);
}

/* ---- run record ---------------------------------------------------------- */

/* The launcher passes its static fields as newline separated key=value lines. */
static int meta_lookup(const char *key, char *out, size_t out_size) {
    const char *meta = getenv("OKPROXY_RUN_META");
    if (meta == NULL || key == NULL || out_size == 0) return 0;
    size_t key_length = strlen(key);
    const char *cursor = meta;
    while (*cursor != '\0') {
        const char *line_end = strchr(cursor, '\n');
        if (line_end == NULL) line_end = cursor + strlen(cursor);
        if ((size_t)(line_end - cursor) > key_length &&
            strncmp(cursor, key, key_length) == 0 && cursor[key_length] == '=') {
            size_t length = (size_t)(line_end - cursor) - key_length - 1;
            if (length >= out_size) length = out_size - 1;
            memcpy(out, cursor + key_length + 1, length);
            out[length] = '\0';
            return 1;
        }
        cursor = (*line_end != '\0') ? line_end + 1 : line_end;
    }
    return 0;
}

static void build_run_record_path(void) {
    const char *directory = getenv("OKPROXY_RUN_DIR");
    if (directory == NULL || *directory == '\0') return;
    char role[64];
    if (!meta_lookup("role", role, sizeof(role)) || role[0] == '\0') {
        snprintf(role, sizeof(role), "child");
    }
    /* The record name must stay a single plain path component. */
    for (size_t index = 0; role[index] != '\0'; index++) {
        char character = role[index];
        int safe = (character >= 'a' && character <= 'z') ||
                   (character >= 'A' && character <= 'Z') ||
                   (character >= '0' && character <= '9') || character == '-';
        if (!safe) role[index] = '_';
    }
    snprintf(run_record_path, sizeof(run_record_path), "%s/run-%s-%d.record",
             directory, role, (int)getpid());
}

/* Rewrites the whole record. `attention` marks "cleanup not verified" and is
   exactly what the app uses to tell an incomplete cleanup apart from a workload
   that legitimately exited with status 126. */
static void write_run_record(pid_t workload, int attention) {
    if (run_record_path[0] == '\0') return;
    const char *meta = getenv("OKPROXY_RUN_META");
    if (meta == NULL) meta = "";
    char buffer[4096];
    int length = snprintf(
        buffer, sizeof(buffer),
        "%s%shelper_pid=%d\nworkload_pid=%d\npgid=%d\nstarted=%.6f\nattention=%d\n",
        meta, (meta[0] != '\0' && meta[strlen(meta) - 1] != '\n') ? "\n" : "",
        (int)getpid(), (int)workload, (int)workload, epoch_seconds(), attention);
    if (length <= 0) return;
    if ((size_t)length >= sizeof(buffer)) length = (int)sizeof(buffer) - 1;
    int descriptor = open(run_record_path, O_WRONLY | O_CREAT | O_TRUNC, 0600);
    if (descriptor < 0) {
        fprintf(stderr, "okproxy helper: cannot write run record %s (errno %d: %s)\n",
                run_record_path, errno, strerror(errno));
        return;
    }
    ssize_t written = 0;
    while (written < length) {
        ssize_t step = write(descriptor, buffer + written, (size_t)(length - written));
        if (step <= 0) {
            if (errno == EINTR) continue;
            break;
        }
        written += step;
    }
    close(descriptor);
}

static void remove_run_record(void) {
    if (run_record_path[0] == '\0') return;
    if (unlink(run_record_path) != 0 && errno != ENOENT) {
        fprintf(stderr, "okproxy helper: cannot remove run record %s (errno %d: %s)\n",
                run_record_path, errno, strerror(errno));
    }
}

/* ---- process group inspection and signaling ------------------------------ */

struct group_member {
    pid_t pid;
    uid_t uid;
};

/* Live (non-zombie) members of `pgid`. Returns the member count, or -1 when the
   group cannot be enumerated on this platform. `out` is filled up to `capacity`,
   but the returned count is the true total. */
static int group_live_members(pid_t pgid, struct group_member *out, int capacity) {
#ifdef __APPLE__
    int mib[4] = { CTL_KERN, KERN_PROC, KERN_PROC_PGRP, (int)pgid };
    size_t size = 0;
    if (sysctl(mib, 4, NULL, &size, NULL, 0) != 0 || size == 0) return (size == 0) ? 0 : -1;
    if (size % sizeof(struct kinfo_proc) != 0) {
        size += sizeof(struct kinfo_proc) - (size % sizeof(struct kinfo_proc));
    }
    if (size > (8 * 1024 * 1024)) return -1;
    struct kinfo_proc *entries = malloc(size);
    if (entries == NULL) return -1;
    if (sysctl(mib, 4, entries, &size, NULL, 0) != 0) {
        free(entries);
        return -1;
    }
    int count = (int)(size / sizeof(struct kinfo_proc));
    int found = 0;
    for (int index = 0; index < count; index++) {
        struct kinfo_proc *entry = &entries[index];
        pid_t pid = entry->kp_proc.p_pid;
        if (pid <= 0) continue;
        if (entry->kp_proc.p_stat == SZOMB) continue; /* exited: cannot run again */
        if (out != NULL && found < capacity) {
            out[found].pid = pid;
            out[found].uid = entry->kp_eproc.e_ucred.cr_uid;
        }
        found++;
    }
    free(entries);
    return found;
#else
    (void)pgid;
    (void)out;
    (void)capacity;
    return -1;
#endif
}

/* Signals the workload's whole process group.
   Returns 0 when the signal was delivered or the group is confirmed empty, and
   the refusing errno when a live member could not be signalled. On a non-zero
   return `out_members`/`out_count` describe the live members to sweep. */
static int group_signal(pid_t pgid, int signal_number, struct group_member *out_members,
                        int capacity, int *out_count) {
    if (out_count != NULL) *out_count = 0;
    errno = 0;
    if (kill(-pgid, signal_number) == 0) return 0;
    int error = errno;
    if (error == ESRCH) return 0; /* the group is already gone */

    /* Darwin reports EPERM - not ESRCH - when no member can receive the signal.
       The ordinary cause is a group whose only member is the already-exited
       leader standing in as an unreaped zombie. Never assume; probe. */
    struct group_member members[GROUP_SWEEP_CAPACITY];
    int live = group_live_members(pgid, members, GROUP_SWEEP_CAPACITY);
    if (live == 0) return 0;
    if (live > 0 && out_members != NULL && out_count != NULL) {
        int copy = (live < capacity) ? live : capacity;
        memcpy(out_members, members, (size_t)copy * sizeof(struct group_member));
        *out_count = live;
    }
    return error;
}

/* Signals surviving members one PID at a time; this is the only handle left when
   a group signal is refused. Returns the number of live members it could not
   signal (not ours to kill, or the signal was refused). */
static int sweep_group_members(const struct group_member *members, int count) {
    uid_t self_uid = getuid();
    int unsignalable = 0;
    for (int index = 0; index < count; index++) {
        pid_t pid = members[index].pid;
        if (pid <= 1 || pid == getpid()) continue;
        if (members[index].uid != self_uid) {
            unsignalable++;
            continue;
        }
        if (kill(pid, SIGKILL) != 0 && errno != ESRCH) unsignalable++;
    }
    return unsignalable;
}

/* Only a group we can actually enumerate may be declared empty, and descendants
   can need a moment to leave the process table after the final group SIGKILL. A
   bounded settle keeps "cleanup unverified" honest instead of reporting a race,
   and never blocks indefinitely. Returns 1 when the group is no longer visible
   as live (empty, or not enumerable on this platform). */
static int wait_for_group_to_clear(pid_t pgid, double seconds) {
    double deadline = now_seconds() + seconds;
    for (;;) {
        if (group_live_members(pgid, NULL, 0) <= 0) return 1;
        if (now_seconds() >= deadline) return 0;
        sleep_milliseconds(20);
    }
}

/* Bounded reap. Returns 0 on a confirmed reap, -1 when the leader is still alive
   or no longer waitable. Never blocks indefinitely: an unkillable workload must
   not turn the helper into an unkillable process. */
static int reap_workload(pid_t workload, int *status_out, double seconds) {
    double deadline = now_seconds() + seconds;
    for (;;) {
        int status = 0;
        pid_t waited = waitpid(workload, &status, WNOHANG);
        if (waited == workload) {
            *status_out = status;
            return 0;
        }
        if (waited < 0 && errno != EINTR) return -1;
        if (now_seconds() >= deadline) return -1;
        sleep_milliseconds(20);
    }
}

/* ---- main ---------------------------------------------------------------- */

static void request(int signal_number) {
    stopping = 1;
    if (signal_number == SIGUSR1) force = 1;
}

int main(int argc, char **argv) {
    if (argc < 4) return HELPER_SETUP_FAILURE;
    pid_t owner = (pid_t)strtol(argv[1], NULL, 10);
    if (owner <= 1 || getppid() != owner) return HELPER_SETUP_FAILURE;

    struct sigaction action;
    memset(&action, 0, sizeof(action));
    action.sa_handler = request;
    sigemptyset(&action.sa_mask);
    if (sigaction(SIGTERM, &action, NULL) != 0 ||
        sigaction(SIGINT, &action, NULL) != 0 ||
        sigaction(SIGUSR1, &action, NULL) != 0) return HELPER_SETUP_FAILURE;

    /* Launcher blocks controls across exec. Keep them blocked through fork so the
       workload cannot run an inherited helper handler before resetting it. */
    sigset_t empty;
    sigemptyset(&empty);
    /* Ensure waitid owns the workload even if the launching environment ignored CHLD. */
    signal(SIGCHLD, SIG_DFL);

    pid_t workload = fork();
    if (workload < 0) return HELPER_SETUP_FAILURE;
    if (workload == 0) {
        if (setpgid(0, 0) != 0) _exit(HELPER_SETUP_FAILURE);
        signal(SIGTERM, SIG_DFL);
        signal(SIGINT, SIG_DFL);
        signal(SIGUSR1, SIG_DFL);
        if (sigprocmask(SIG_SETMASK, &empty, NULL) != 0) _exit(HELPER_SETUP_FAILURE);
        /* Supervisory bookkeeping never leaks into the workload. */
        unsetenv("OKPROXY_RUN_DIR");
        unsetenv("OKPROXY_RUN_META");
        if (chdir(argv[2]) != 0) _exit(HELPER_SETUP_FAILURE);
        execv(argv[3], &argv[3]);
        _exit(127);
    }

    /* The child establishes its own group with setpgid(0, 0) before exec, so a
       parent-side failure here is either the documented post-exec EACCES/EPERM
       race (the group is already correct) or a real setup problem. */
    errno = 0;
    if (setpgid(workload, workload) != 0) {
        int error = errno;
        if (error != EACCES && error != EPERM) {
            fprintf(stderr, "okproxy helper: cannot isolate workload %d in its own group (errno %d: %s)\n",
                    (int)workload, error, strerror(error));
            return HELPER_SETUP_FAILURE;
        }
    }
    if (sigprocmask(SIG_SETMASK, &empty, NULL) != 0) return HELPER_SETUP_FAILURE;

    build_run_record_path();
    write_run_record(workload, 0);

    double stop_deadline = 0;
    for (;;) {
        siginfo_t info;
        memset(&info, 0, sizeof(info));
        errno = 0;
        int waited = waitid(P_PID, (id_t)workload, &info, WEXITED | WNOHANG | WNOWAIT);
        if (waited < 0 && errno != EINTR) {
            fprintf(stderr, "okproxy helper: cannot observe workload %d (errno %d: %s); releasing it to the app\n",
                    (int)workload, errno, strerror(errno));
            write_run_record(workload, 1);
            return HELPER_CLEANUP_ATTENTION;
        }
        int leader_exited = (info.si_pid == workload);

        if (getppid() != owner) stopping = 1;
        if (stopping && stop_deadline == 0) {
            struct group_member members[GROUP_SWEEP_CAPACITY];
            int live = 0;
            int refused = group_signal(workload, SIGTERM, members, GROUP_SWEEP_CAPACITY, &live);
            if (refused != 0) {
                fprintf(stderr, "okproxy helper: workload group %d refused SIGTERM (errno %d: %s); %d member(s) will be swept\n",
                        (int)workload, refused, strerror(refused), live);
            }
            stop_deadline = now_seconds() + WORKLOAD_STOP_GRACE_SECONDS;
        }

        if (leader_exited || force || (stop_deadline > 0 && now_seconds() >= stop_deadline)) {
            /* Also clean descendants after a natural leader exit. WNOWAIT keeps the
               leader unreaped during this final group signal, pinning the group. */
            int attention = 0;
            struct group_member members[GROUP_SWEEP_CAPACITY];
            int live = 0;
            int refused = group_signal(workload, SIGKILL, members, GROUP_SWEEP_CAPACITY, &live);
            if (refused != 0) {
                fprintf(stderr, "okproxy helper: workload group %d refused SIGKILL (errno %d: %s); sweeping %d member(s) individually\n",
                        (int)workload, refused, strerror(refused), live);
                if (sweep_group_members(members, live) > 0 ||
                    !wait_for_group_to_clear(workload, GROUP_SETTLE_SECONDS)) attention = 1;
            }

            int status = 0;
            if (reap_workload(workload, &status, WORKLOAD_REAP_WINDOW_SECONDS) != 0) {
                fprintf(stderr, "okproxy helper: workload %d was not reaped within %.1fs; run record retained for the app\n",
                        (int)workload, WORKLOAD_REAP_WINDOW_SECONDS);
                write_run_record(workload, 1);
                return HELPER_CLEANUP_ATTENTION;
            }
            if (!attention && !wait_for_group_to_clear(workload, GROUP_SETTLE_SECONDS)) attention = 1;
            if (attention) {
                fprintf(stderr, "okproxy helper: descendant cleanup for workload %d could not be verified; run record retained for the app\n",
                        (int)workload);
                write_run_record(workload, 1);
                return HELPER_CLEANUP_ATTENTION;
            }
            remove_run_record();
            return WIFEXITED(status) ? WEXITSTATUS(status) : 128 + WTERMSIG(status);
        }

        sleep_milliseconds(20);
    }
}
