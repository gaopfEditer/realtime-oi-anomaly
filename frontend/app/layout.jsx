import './globals.css';

export const metadata = {
  title: 'EzRadar — OI 异动雷达',
  description: '演示数据 · 未平仓异动雷达终端',
};

export default function RootLayout({ children }) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
