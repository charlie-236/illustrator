import { ImageResponse } from 'next/og';

export const size = { width: 512, height: 512 };
export const contentType = 'image/png';

export default function Icon() {
  return new ImageResponse(
    (
      <div
        style={{
          width: 512,
          height: 512,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: 'linear-gradient(145deg, #18181b 0%, #09090b 100%)',
        }}
      >
        {/* Soft violet bloom behind the letterform */}
        <div
          style={{
            position: 'absolute',
            width: 300,
            height: 300,
            borderRadius: 150,
            background: 'rgba(109, 40, 217, 0.28)',
            display: 'flex',
          }}
        />
        {/* Stylised "I" mark */}
        <span
          style={{
            fontSize: 320,
            fontWeight: 900,
            color: '#c4b5fd',
            lineHeight: 1,
            fontFamily: 'serif',
            position: 'relative',
          }}
        >
          I
        </span>
      </div>
    ),
    { width: 512, height: 512 },
  );
}
