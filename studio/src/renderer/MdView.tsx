import type { ReactNode } from "react";

/** 极简 Markdown 渲染(零依赖):支持 #/##/### 标题、- 列表、``` 代码块、**粗体**、`行内码`、> 引用 */
function inline(text: string, keyBase: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const tok = m[0];
    if (tok.startsWith("**")) {
      out.push(<strong key={`${keyBase}-b${i}`}>{tok.slice(2, -2)}</strong>);
    } else {
      out.push(
        <code key={`${keyBase}-c${i}`} className="md-inline-code">
          {tok.slice(1, -1)}
        </code>,
      );
    }
    last = m.index + tok.length;
    i++;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function MdView({ text }: { text: string }) {
  const lines = text.replaceAll("\r\n", "\n").split("\n");
  const blocks: ReactNode[] = [];
  let codeBuf: string[] | null = null;
  let ulBuf: string[] | null = null;
  let olBuf: string[] | null = null;
  let key = 0;

  const flushUl = () => {
    if (ulBuf) {
      blocks.push(
        <ul key={`ul${key++}`} className="md-ul">
          {ulBuf.map((li, i) => (
            <li key={i}>{inline(li, `li${key}-${i}`)}</li>
          ))}
        </ul>,
      );
      ulBuf = null;
    }
  };

  const flushOl = () => {
    if (olBuf) {
      blocks.push(
        <ol key={`ol${key++}`} className="md-ol">
          {olBuf.map((li, i) => (
            <li key={i}>{inline(li, `oli${key}-${i}`)}</li>
          ))}
        </ol>,
      );
      olBuf = null;
    }
  };

  const flushLists = () => {
    flushUl();
    flushOl();
  };

  for (const raw of lines) {
    const line = raw.trimEnd();
    if (line.trim().startsWith("```")) {
      if (codeBuf === null) {
        flushLists();
        codeBuf = [];
      } else {
        blocks.push(
          <pre key={`code${key++}`} className="md-pre">
            {codeBuf.join("\n")}
          </pre>,
        );
        codeBuf = null;
      }
      continue;
    }
    if (codeBuf !== null) {
      codeBuf.push(line);
      continue;
    }
    if (!line.trim()) {
      flushLists();
      continue;
    }
    // 有序列表:「N. 内容」(允许缩进,分点文档的主体形态)
    const olMatch = /^(\d+)\.\s+(.*)$/.exec(line.trim());
    if (olMatch) {
      flushUl();
      if (!olBuf) olBuf = [];
      olBuf.push(olMatch[2]!);
      continue;
    }
    if (line.startsWith("### ")) {
      flushLists();
      blocks.push(<h5 className="md-h3">{inline(line.slice(4), `h${key++}`)}</h5>);
    } else if (line.startsWith("## ")) {
      flushLists();
      blocks.push(<h4 className="md-h2">{inline(line.slice(3), `h${key++}`)}</h4>);
    } else if (line.startsWith("# ")) {
      flushLists();
      blocks.push(<h3 className="md-h1">{inline(line.slice(2), `h${key++}`)}</h3>);
    } else if (line.startsWith("- ") || line.startsWith("* ")) {
      flushOl();
      if (!ulBuf) ulBuf = [];
      ulBuf.push(line.slice(2));
    } else if (line.startsWith("> ")) {
      flushLists();
      blocks.push(
        <blockquote key={`q${key++}`} className="md-quote">
          {inline(line.slice(2), `q${key}`)}
        </blockquote>,
      );
    } else {
      flushLists();
      blocks.push(<div className="md-p">{inline(line, `p${key++}`)}</div>);
    }
  }
  flushLists();
  if (codeBuf) {
    blocks.push(
      <pre key={`code-end`} className="md-pre">
        {codeBuf.join("\n")}
      </pre>,
    );
  }
  return <div className="md">{blocks}</div>;
}
