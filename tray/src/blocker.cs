using System;
using System.Runtime.InteropServices;
using System.Windows.Forms;

// A hidden window that holds a Windows shutdown back for as long as it runs; shutdown-block.js compiles, starts and
// stops it. The reason given to ShutdownBlockReasonCreate is what Windows shows next to it.
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
        ShutdownBlockReasonCreate(this.Handle, "MindGate is processing AI requests — please wait until it is done.");
        
        Console.WriteLine("BLOCKER_READY");
    }

    protected override void WndProc(ref Message m) {
        if (m.Msg == WM_QUERYENDSESSION) {
            // answering 0 asks Windows to hold the shutdown back
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
