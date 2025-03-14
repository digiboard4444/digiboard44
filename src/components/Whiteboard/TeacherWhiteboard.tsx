import React, { useRef, useState, useEffect, useCallback } from 'react';
import { ReactSketchCanvas, ReactSketchCanvasRef } from 'react-sketch-canvas';
import { Play, X, Eraser } from 'lucide-react';
import { io } from 'socket.io-client';

const socket = io(import.meta.env.VITE_API_URL, {
  transports: ['websocket'],
  reconnection: true,
  reconnectionAttempts: 5,
  reconnectionDelay: 1000
});

const TeacherWhiteboard: React.FC = () => {
  const canvasRef = useRef<ReactSketchCanvasRef | null>(null);
  const [isLive, setIsLive] = useState(false);
  const [showModal, setShowModal] = useState(false);
  const [canvasSize, setCanvasSize] = useState({ width: 800, height: 600 });

  useEffect(() => {
    const handleResize = () => {
      const container = document.getElementById('whiteboard-container');
      if (container) {
        const width = container.clientWidth;
        const height = Math.min(window.innerHeight - 200, width * 0.75);
        setCanvasSize({ width, height });
      }
    };

    handleResize();
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  useEffect(() => {
    const userId = localStorage.getItem('userId');

    const handleConnect = () => {
      console.log('Connected to server');
      if (isLive && userId) {
        socket.emit('startLive', userId);
        handleStroke(); // Send current canvas state
      }
    };

    const handleDisconnect = () => {
      console.log('Disconnected from server');
      setIsLive(false);
    };

    socket.on('connect', handleConnect);
    socket.on('disconnect', handleDisconnect);

    return () => {
      socket.off('connect', handleConnect);
      socket.off('disconnect', handleDisconnect);
      if (userId && isLive) {
        socket.emit('stopLive', userId);
      }
    };
  }, [isLive]);

  const handleStartLive = () => {
    setShowModal(true);
  };

  const confirmStartLive = async () => {
    const userId = localStorage.getItem('userId');
    if (userId && canvasRef.current) {
      setIsLive(true);
      setShowModal(false);
      socket.emit('startLive', userId);
      
      // Send initial canvas state
      const paths = await canvasRef.current.exportPaths();
      socket.emit('whiteboardUpdate', {
        teacherId: userId,
        whiteboardData: JSON.stringify(paths)
      });
    }
  };

  const handleStopLive = () => {
    const userId = localStorage.getItem('userId');
    if (userId) {
      setIsLive(false);
      socket.emit('stopLive', userId);
      if (canvasRef.current) {
        canvasRef.current.clearCanvas();
      }
    }
  };

  const handleStroke = useCallback(async () => {
    if (isLive && canvasRef.current) {
      try {
        const paths = await canvasRef.current.exportPaths();
        const userId = localStorage.getItem('userId');
        if (userId) {
          console.log('Sending whiteboard update');
          socket.emit('whiteboardUpdate', {
            teacherId: userId,
            whiteboardData: JSON.stringify(paths)
          });
        }
      } catch (error) {
        console.error('Error handling stroke:', error);
      }
    }
  }, [isLive]);

  const handleClearCanvas = async () => {
    if (canvasRef.current && isLive) {
      await canvasRef.current.clearCanvas();
      const userId = localStorage.getItem('userId');
      if (userId) {
        socket.emit('whiteboardUpdate', {
          teacherId: userId,
          whiteboardData: JSON.stringify([])
        });
      }
    }
  };

  return (
    <>
      <div className="p-4">
        <div className="mb-4 flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
          <h2 className="text-2xl font-bold">Live Whiteboard</h2>
          <div className="flex flex-wrap gap-2">
            {isLive && (
              <button
                onClick={handleClearCanvas}
                className="flex items-center gap-2 px-4 py-2 rounded-md bg-yellow-500 hover:bg-yellow-600 text-white"
              >
                <Eraser size={20} /> Clear Board
              </button>
            )}
            <button
              onClick={isLive ? handleStopLive : handleStartLive}
              className={`flex items-center gap-2 px-4 py-2 rounded-md ${
                isLive 
                  ? 'bg-red-500 hover:bg-red-600' 
                  : 'bg-green-500 hover:bg-green-600'
              } text-white`}
            >
              {isLive ? (
                <>
                  <X size={20} /> Stop Live
                </>
              ) : (
                <>
                  <Play size={20} /> Start Live
                </>
              )}
            </button>
          </div>
        </div>
        <div id="whiteboard-container" className="border rounded-lg overflow-hidden bg-white">
          <ReactSketchCanvas
            ref={canvasRef}
            strokeWidth={4}
            strokeColor="black"
            width={`${canvasSize.width}px`}
            height={`${canvasSize.height}px`}
            canvasColor="white"
            exportWithBackgroundImage={false}
            withTimestamp={false}
            allowOnlyPointerType="all"
            className="touch-none"
            onStroke={handleStroke}
            onChange={handleStroke}
          />
        </div>
      </div>

      {/* Confirmation Modal */}
      {showModal && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-lg p-6 max-w-md w-full mx-4">
            <h3 className="text-xl font-bold mb-4">Start Live Session</h3>
            <p className="text-gray-600 mb-6">
              Are you sure you want to start a live whiteboard session? Students will be able to join and view your whiteboard.
            </p>
            <div className="flex flex-col sm:flex-row justify-end gap-3">
              <button
                onClick={() => setShowModal(false)}
                className="px-4 py-2 rounded-md bg-gray-200 hover:bg-gray-300 text-gray-800"
              >
                Cancel
              </button>
              <button
                onClick={confirmStartLive}
                className="px-4 py-2 rounded-md bg-green-500 hover:bg-green-600 text-white"
              >
                Start Session
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
};

export default TeacherWhiteboard;