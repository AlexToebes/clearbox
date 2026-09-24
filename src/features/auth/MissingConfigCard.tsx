import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

/** Shown when `.env.local` has no Google OAuth client configured. */
export function MissingConfigCard() {
  return (
    <Card className="w-full max-w-md">
      <CardHeader>
        <CardTitle className="text-2xl">Clearbox</CardTitle>
        <CardDescription>Google sign-in isn't configured yet.</CardDescription>
      </CardHeader>
      <CardContent className="text-muted-foreground flex flex-col gap-2 text-sm">
        <p>
          Clearbox needs a Google OAuth client to connect to Gmail. Copy{" "}
          <code className="bg-muted rounded px-1 py-0.5">.env.example</code> to{" "}
          <code className="bg-muted rounded px-1 py-0.5">.env.local</code> and
          fill in your client ID and secret.
        </p>
        <p>See the README for step-by-step Google Cloud setup instructions.</p>
      </CardContent>
    </Card>
  );
}
