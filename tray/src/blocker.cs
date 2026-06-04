using System;
using System.Runtime.InteropServices;
using System.Windows.Forms;

public class ShutdownBlocker : Form {
    [DllImport("user32.dll")]
    public static extern bool ShutdownBlockReasonCreate(IntPtr hWnd, [MarshalAs(UnmanagedType.LPWStr)] string pwszReason);

    [DllImport("user32.dll")]
    public static extern bool ShutdownBlockReasonDestroy(IntPtr hWnd);

    private const int WM_QUERYENDSESSION = 0x0011;

    public ShutdownBlocker() {
        this.Text = "MindGate Shutdown Guard";
        this.ShowInTaskbar = false;
        this.WindowState = FormWindowState.Minimized;
        this.FormBorderStyle = FormBorderStyle.None;
        this.Opacity = 0;
    }

    protected override void OnHandleCreated(EventArgs e) {
        base.OnHandleCreated(e);
        ShutdownBlockReasonCreate(this.Handle, "MindGate przetwarza żądania AI — poczekaj na zakończenie.");
        
        // Let the parent process know we are ready
        Console.WriteLine("BLOCKER_READY");
    }

    protected override void WndProc(ref Message m) {
        if (m.Msg == WM_QUERYENDSESSION) {
            // Block shutdown
            m.Result = IntPtr.Zero;
            return;
        }
        base.WndProc(ref m);
    }

    protected override void OnFormClosing(FormClosingEventArgs e) {
        ShutdownBlockReasonDestroy(this.Handle);
        base.OnFormClosing(e);
    }

    [STAThread]
    static void Main() {
        Application.Run(new ShutdownBlocker());
    }
}
