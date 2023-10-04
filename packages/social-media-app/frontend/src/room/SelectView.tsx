import { CanvasView, ChatView, Element } from '@dao-xyz/social'
import { ViewChat } from './ViewChat'
import { ViewSpatial } from './ViewSpatial'
import { useEffect, useState } from 'react'
import { HiOutlineChatAlt2 } from 'react-icons/hi'
import { SearchRequest } from '@peerbit/document'

export const SelectView = (properties: { element: Element }) => {

    /*  const [views, setViews] = useState<View[]>([])
   const [selected, setSelected] = useState<View | undefined>(undefined)
   useEffect(() => {
         if (!properties.element || properties.element.closed) {
             return;
         }
         const update = () => {
             properties.element.replies.views.index.search(new SearchRequest()).then((views) => {
                 console.log("SET VIEwS", views)
                 setViews(views)
                 if (!selected) {
                     setSelected(views[0])
                 }
             })
         }
         update()
         properties.element.replies.views.events.addEventListener('change', update)
         return () => {
             properties.element.replies.views.events.removeEventListener('change', update)
 
         }
     }, [properties.element?.closed || properties.element?.address])
 
     const selectView = () => {
         if (selected instanceof ChatView) {
             return <ViewChat room={selected} />
         }
 
         if (selected instanceof CanvasView) {
             return <ViewSpatial room={selected} />
         }
     }
 
     const viewSelectButton = (view: View) => {
         return <button className='btn btn-icon btn-elevated btn-toggle' ><HiOutlineChatAlt2 /></button>
     } */
    return <>
        <>
            {/*  <button
                onClick={() => {
                    console.log("SAVE?");
                }}
                className="btn btn-icon btn-elevated relative"
            >
                <BsLayoutWtf />
                <div className="absolute top-[-5px] right-[2px]   text-sm ">
                    +
                </div>
            </button> */}
        </>
        {/*      <div className='w-full flex'>
            {

                views && views.map((x, ix) => {
                    return <div key={ix} className={`${ix === 0 ? '' : ''}`} >{viewSelectButton(x)}</div>
                })
            }
        </div> */}
        {/*   {selected && selectView()} */}
    </>
    /* return select() */
}