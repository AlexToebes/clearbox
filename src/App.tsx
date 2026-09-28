import { Toaster } from "@/components/ui/sonner";
import { AuthProvider } from "@/features/auth/AuthProvider";
import { AuthScreen } from "@/features/auth/AuthScreen";

function App() {
  return (
    <AuthProvider>
      <AuthScreen />
      <Toaster />
    </AuthProvider>
  );
}

export default App;
