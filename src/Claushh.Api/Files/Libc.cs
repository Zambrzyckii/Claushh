// libc calls that System.IO does not offer: resolving every symlink of a path (realpath(3)), the type of a file without
// following a final symlink (statx(2)), so FIFOs and devices are never opened, whether the process may use a directory
// (access(2)), making the process non-dumpable (prctl(2)) and asking a process to end (kill(2) with SIGTERM, for git's
// process tree). Linux only, like the deployment (docs/PLAN.md, "Backend decisions (stage 2)").
using System.Runtime.InteropServices;

namespace Claushh.Api.Files;

internal static class Libc
{
    public const int ENOENT = 2;
    public const int EACCES = 13;
    public const int ENOTDIR = 20;
    public const int ENAMETOOLONG = 36;
    public const int ELOOP = 40;

    public const int S_IFMT = 0xF000;
    public const int S_IFDIR = 0x4000;
    public const int S_IFREG = 0x8000;

    private const int AtFdCwd = -100;
    private const int AtSymlinkNoFollow = 0x100;
    private const uint StatxType = 0x1;
    // struct statx has the same layout on every architecture: 256 bytes, the 16-bit stx_mode at byte 28.
    private const int StatxSize = 256;
    private const int StatxModeOffset = 28;
    // The access(2) mode R_OK | W_OK | X_OK.
    private const int AccessReadWriteSearch = 4 | 2 | 1;
    // PR_SET_DUMPABLE of <linux/prctl.h>.
    private const int PrSetDumpable = 4;
    // SIGTERM of <signal.h>.
    private const int SigTerm = 15;

    // The path with every symlink resolved, or null with errno (ENOENT, ENOTDIR, ELOOP, …).
    public static string? RealPath(string path, out int errno)
    {
        var resolved = RealPathNative(path, 0);
        if (resolved == 0)
        {
            errno = Marshal.GetLastPInvokeError();
            return null;
        }
        try
        {
            errno = 0;
            return Marshal.PtrToStringUTF8(resolved);
        }
        finally
        {
            Free(resolved);
        }
    }

    // The type bits (S_IFMT) of the path itself, a final symlink not followed; null when statx fails: nothing is there,
    // or a directory on the way cannot be searched.
    public static int? FileType(string path)
    {
        var buffer = new byte[StatxSize];
        return StatxNative(AtFdCwd, path, AtSymlinkNoFollow, StatxType, buffer) == 0
            ? BitConverter.ToUInt16(buffer, StatxModeOffset) & S_IFMT
            : null;
    }

    // Whether this process may read, write and search the directory; a symlink is followed.
    public static bool CanReadWriteAndSearch(string path) => AccessNative(path, AccessReadWriteSearch) == 0;

    // prctl(PR_SET_DUMPABLE, 0): the process's /proc files belong to root and no process of its user can attach to it.
    public static bool MakeNotDumpable() => PrctlNative(PrSetDumpable, 0, 0, 0, 0) == 0;

    // kill(pid, SIGTERM): asks a process to end, so it can clean up first; false when there is no such process.
    public static bool Terminate(int pid) => KillNative(pid, SigTerm) == 0;

    [DllImport("libc", EntryPoint = "realpath", SetLastError = true)]
    private static extern nint RealPathNative([MarshalAs(UnmanagedType.LPUTF8Str)] string path, nint resolved);

    [DllImport("libc", EntryPoint = "free")]
    private static extern void Free(nint pointer);

    [DllImport("libc", EntryPoint = "statx", SetLastError = true)]
    private static extern int StatxNative(int directory, [MarshalAs(UnmanagedType.LPUTF8Str)] string path, int flags, uint mask, byte[] buffer);

    [DllImport("libc", EntryPoint = "access", SetLastError = true)]
    private static extern int AccessNative([MarshalAs(UnmanagedType.LPUTF8Str)] string path, int mode);

    [DllImport("libc", EntryPoint = "prctl", SetLastError = true)]
    private static extern int PrctlNative(int option, nuint arg2, nuint arg3, nuint arg4, nuint arg5);

    [DllImport("libc", EntryPoint = "kill", SetLastError = true)]
    private static extern int KillNative(int pid, int signal);
}
