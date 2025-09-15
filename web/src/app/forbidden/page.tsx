// web/src/app/forbidden/page.tsx
export default function ForbiddenPage() {
  return (
    <div style={{minHeight:"100dvh",display:"grid",placeItems:"center",padding:"2rem"}}>
      <div style={{maxWidth:480,width:"100%",textAlign:"center"}}>
        <h1 style={{fontSize:28,marginBottom:8}}>Access denied</h1>
        <p style={{opacity:0.75,marginBottom:16}}>
          You’re signed in, but your role doesn’t allow this section.
        </p>
        <a href="/" style={{
          display:"inline-block",
          padding:"10px 16px",
          borderRadius:8,
          background:"#111827",
          color:"#fff",
          textDecoration:"none"
        }}>
          Go home
        </a>
      </div>
    </div>
  );
}
