import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

function App() {
  return (
    <main className="flex min-h-screen items-center justify-center p-6">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="text-2xl">Clearbox</CardTitle>
          <CardDescription>Clean up your Gmail, locally.</CardDescription>
        </CardHeader>
        <CardContent>
          <Button className="w-full">Connect Gmail</Button>
        </CardContent>
      </Card>
    </main>
  );
}

export default App;
