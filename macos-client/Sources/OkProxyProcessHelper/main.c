// Private direct-child supervisor. Never reap the workload leader before the
// last group signal: its live/zombie PID pins the group identity against reuse.
#include <sys/types.h>
#include <sys/wait.h>
#include <signal.h>
#include <unistd.h>
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <time.h>
static volatile sig_atomic_t stopping, force;
static void request(int sig) { stopping = 1; if (sig == SIGUSR1) force = 1; }
static double now(void) { struct timespec t; clock_gettime(CLOCK_MONOTONIC, &t); return t.tv_sec + t.tv_nsec / 1e9; }
static void ownership_failure(void) {
    // Fail closed: do not signal an identity no longer owned, or report success.
    perror("okproxy helper ownership failure");
    for (;;) pause();
}
int main(int argc, char **argv) {
    if (argc < 4) return 125;
    pid_t owner = (pid_t)strtol(argv[1], NULL, 10);
    if (owner <= 1 || getppid() != owner) return 125;
    struct sigaction action = {0}; action.sa_handler = request;
    sigemptyset(&action.sa_mask);
    if (sigaction(SIGTERM, &action, NULL) != 0 ||
        sigaction(SIGINT, &action, NULL) != 0 ||
        sigaction(SIGUSR1, &action, NULL) != 0) return 125;
    // Launcher blocks controls across exec. Keep them blocked through fork so
    // the workload cannot run an inherited helper handler before resetting it.
    sigset_t empty;
    sigemptyset(&empty);
    // Ensure waitid owns the workload even if the launching environment ignored CHLD.
    signal(SIGCHLD, SIG_DFL);
    pid_t child = fork();
    if (child < 0) return 125;
    if (child == 0) {
        if (setpgid(0, 0) != 0) _exit(125);
        signal(SIGTERM, SIG_DFL); signal(SIGINT, SIG_DFL); signal(SIGUSR1, SIG_DFL);
        if (sigprocmask(SIG_SETMASK, &empty, NULL) != 0) _exit(125);
        if (chdir(argv[2]) != 0) _exit(125);
        execv(argv[3], &argv[3]); _exit(127);
    }
    if (setpgid(child, child) != 0 && errno != EACCES) ownership_failure();
    if (sigprocmask(SIG_SETMASK, &empty, NULL) != 0) ownership_failure();
    double deadline = 0;
    for (;;) {
        siginfo_t info = {0};
        int rc = waitid(P_PID, child, &info, WEXITED | WNOHANG | WNOWAIT);
        if (rc < 0) { if (errno == EINTR) continue; ownership_failure(); }
        if (getppid() != owner) stopping = 1;
        if (stopping && deadline == 0) {
            if (kill(-child, SIGTERM) != 0 && errno != ESRCH) ownership_failure();
            deadline = now() + 2.0;
        }
        if (info.si_pid == child || force || (deadline && now() >= deadline)) {
            // Also clean descendants after a natural leader exit. WNOWAIT keeps
            // the leader unreaped during this final group signal.
            if (kill(-child, SIGKILL) != 0 && errno != ESRCH) ownership_failure();
            int status; pid_t waited;
            do { waited = waitpid(child, &status, 0); } while (waited < 0 && errno == EINTR);
            if (waited != child) ownership_failure();
            return WIFEXITED(status) ? WEXITSTATUS(status) : 128 + WTERMSIG(status);
        }
        struct timespec delay = {0, 20000000}; nanosleep(&delay, NULL);
    }
}
