import { Toaster } from "@/components/ui/sonner";
import { AuthProvider } from "@/features/auth/AuthProvider";
import { AuthScreen } from "@/features/auth/AuthScreen";

function App() {
  return (
    <AuthProvider>
      <main className="flex min-h-screen items-center justify-center p-6">
        <AuthScreen />
      </main>
      <Toaster />
    </AuthProvider>
  );
}

export default App;
